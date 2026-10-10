// Per-person memory: what a person and this agent said, kept per person
// across every Chat they share, so a turn in one Chat can read the others.
// The shape copies Cloudflare Agent Memory's profiles (one isolated store per
// user, developers.cloudflare.com/agent-memory/concepts/namespaces-profiles)
// on the released Agents SDK pieces: one Durable Object per person, named the
// Per-User Agents way (agents docs/routing.md), each holding an
// AgentSearchProvider index (agents docs/context.md). This file is the plain
// code both sides share; ./memory.ts is the Worker entry with the Durable
// Object.
import { getToolName, isToolUIPart, type UIMessage } from "ai";

import { relayTurnMetadata } from "./stored-history.js";

/** A Chat as GET /v1/chats/{chatId} returns it, reduced to what memory reads. */
export interface PersonMemoryChat {
  id: string;
  display_name?: string | null;
  is_group?: boolean;
  handles: ReadonlyArray<{
    id: string;
    kind: "user" | "agent";
    handle?: string | null;
    display_name?: string | null;
    status?: "active" | "left" | "removed" | null;
    is_me?: boolean | null;
  }>;
}

/** One line of a Chat, as memory stores it. */
export interface PersonMemoryLine {
  /** `<chatId>:<messageId>`, the index key. */
  key: string;
  messageId: string;
  /** ISO time the Message was sent. */
  at: string;
  /** The Handle id of the person or agent who said it; undefined for this agent. */
  speakerId?: string;
  speakerKind: "user" | "agent" | "self";
  speaker: string;
  /** For this agent's lines: the person it answered. */
  answers?: string;
  text: string;
}

const LINE_MAX_CHARACTERS = 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > LINE_MAX_CHARACTERS ? `${flat.slice(0, LINE_MAX_CHARACTERS)}…` : flat;
}

/**
 * The words a Message carried. A person's Message is its text parts. This
 * agent's Message is its text parts plus what it sent through Relay's `send`
 * action (`text`, or an image's `caption`), when Relay answered `sent`.
 */
function messageText(message: UIMessage): string {
  const words: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      words.push(part.text);
      continue;
    }
    if (
      isToolUIPart(part) && getToolName(part) === "send" && part.state === "output-available" &&
      record(part.output)?.status === "sent"
    ) {
      const input = record(part.input);
      for (const key of ["text", "caption"]) {
        if (typeof input?.[key] === "string") words.push(input[key] as string);
      }
    }
  }
  return oneLine(words.join(" "));
}

/** The Relay Message facts @relay stores with a person's Message. */
function relayMessage(message: UIMessage): Record<string, unknown> | undefined {
  const metadata = record(message.metadata);
  return record(record(metadata?.turnMetadata)?.message) ??
    record(relayTurnMetadata(metadata?.messenger)?.message);
}

/** This agent's own name in the Chat. */
export function selfName(chat: PersonMemoryChat): string {
  const me = chat.handles.find((handle) => handle.is_me);
  return me?.display_name ?? me?.handle ?? "Agent";
}

/** `<Chat name>`, or `DM` for a one-to-one Chat with no name. */
export function chatLabel(chat: PersonMemoryChat): string {
  return chat.display_name?.trim() || (chat.is_group ? "Group chat" : "DM");
}

/**
 * The Chat's lines in order, from Think's stored history. Each person's line
 * names its sender; each of this agent's lines names the person whose Message
 * it answered (the last person who spoke before it).
 */
export function personMemoryLines(
  chat: PersonMemoryChat,
  messages: readonly UIMessage[],
  now: () => Date = () => new Date(),
): PersonMemoryLine[] {
  const me = selfName(chat);
  const handles = new Map(chat.handles.map((handle) => [handle.id, handle]));
  const lines: PersonMemoryLine[] = [];
  let lastPerson: string | undefined;
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = messageText(message);
    const facts = relayMessage(message);
    const sentAt = typeof facts?.sent_at === "string" ? facts.sent_at : undefined;
    const messageId = typeof facts?.id === "string" ? facts.id : message.id;
    const base = {
      key: `${chat.id}:${messageId}`,
      messageId,
      at: sentAt ?? now().toISOString(),
    };
    if (message.role === "assistant") {
      if (text) {
        lines.push({
          ...base,
          speakerKind: "self",
          speaker: me,
          ...(lastPerson ? { answers: lastPerson } : {}),
          text,
        });
      }
      continue;
    }
    const sender = record(facts?.sender_handle);
    const speakerId = typeof sender?.id === "string" ? sender.id : undefined;
    if (!speakerId) continue;
    const known = handles.get(speakerId);
    const kind = sender?.kind === "agent" || known?.kind === "agent" ? "agent" : "user";
    if (kind === "user") lastPerson = speakerId;
    if (!text) continue;
    const name = sender?.display_name ?? known?.display_name ?? sender?.handle ?? known?.handle;
    lines.push({
      ...base,
      speakerId,
      speakerKind: kind,
      speaker: typeof name === "string" && name ? name : "Someone",
      text,
    });
  }
  return lines;
}

/**
 * The people in a Chat: its active person Handles, plus anyone whose line is
 * in the history (a person who left still said what they said).
 */
export function chatPeople(
  chat: PersonMemoryChat,
  lines: readonly PersonMemoryLine[],
): Set<string> {
  const people = new Set<string>();
  for (const handle of chat.handles) {
    if (handle.kind === "user" && handle.status !== "left" && handle.status !== "removed") {
      people.add(handle.id);
    }
  }
  for (const line of lines) {
    if (line.speakerKind === "user" && line.speakerId) people.add(line.speakerId);
  }
  return people;
}

/**
 * Which lines go to which person's memory.
 *
 * - A Chat with one person: that person gets every line, theirs, this
 *   agent's, and other agents'.
 * - A Chat with two or more people: each person gets only their own lines
 *   and this agent's answers to them. Another person's lines, and other
 *   agents' lines, go nowhere.
 */
export function personMemoryWrites(
  chat: PersonMemoryChat,
  lines: readonly PersonMemoryLine[],
): Map<string, PersonMemoryLine[]> {
  const people = chatPeople(chat, lines);
  const writes = new Map<string, PersonMemoryLine[]>();
  if (people.size === 1) {
    const [person] = people;
    writes.set(person!, [...lines]);
    return writes;
  }
  for (const person of people) {
    const own = lines.filter((line) =>
      line.speakerKind === "self" ? line.answers === person : line.speakerId === person
    );
    if (own.length) writes.set(person, own);
  }
  return writes;
}

/**
 * The one person this Chat's turn may read memory for, or undefined when
 * the Chat has two or more people (or none): a person's other Chats are
 * theirs, never read where someone else can see the answer.
 */
export function personMemoryReader(
  chat: PersonMemoryChat,
  lines: readonly PersonMemoryLine[],
): string | undefined {
  const people = chatPeople(chat, lines);
  return people.size === 1 ? [...people][0] : undefined;
}

/** The Durable Object name: `person:<personId>`, or `person:<agentId>:<personId>`. */
export function personMemoryName(personId: string, agentId?: string): string {
  return agentId ? `person:${agentId}:${personId}` : `person:${personId}`;
}

/** The indexed content of one line: `[<Chat>, <date>] <speaker>: <text>`. */
export function personMemoryRow(label: string, line: PersonMemoryLine): string {
  return `[${label}, ${line.at.slice(0, 10)}] ${line.speaker}: ${line.text}`;
}

/** What a turn reads back: other Chats' recent lines and search hits. */
export interface PersonMemoryRecall {
  chats: Array<{ label: string; lines: string[] }>;
  hits: string[];
}

/**
 * The memory as one model Message: data, under labels, for the model to use
 * or ignore. Undefined when there is nothing to show.
 */
export function personMemoryContent(recall: PersonMemoryRecall): string | undefined {
  const sections: string[] = [];
  for (const chat of recall.chats) {
    if (chat.lines.length) sections.push(`## ${chat.label}\n${chat.lines.join("\n")}`);
  }
  if (recall.hits.length) sections.push(`## Search hits\n${recall.hits.join("\n")}`);
  if (!sections.length) return undefined;
  return `<person_memory>\nThis person's lines from your other chats with them, oldest first.\n\n${sections.join("\n\n")}\n</person_memory>`;
}
