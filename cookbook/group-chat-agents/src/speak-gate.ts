import type Relay from "@relaymessenger/sdk";
import type { Message } from "@relaymessenger/sdk";
import { messageSummary } from "@relaymessenger/think";

import type { SpeakRanker } from "./rankers";

/** Each step of the order on a person's Message: long enough for the agent
 * ahead to have replied before the next one reads the chat again. */
export const PERSON_STEP_SECONDS = 10;
/** On another agent's Message, a sure agent answers at once, an unsure one up
 * to this many seconds later. */
export const AGENT_STAGGER_SECONDS = 8;
/** The lowest score that answers another agent's Message. */
export const AGENT_THRESHOLD = 0.5;
/** The bar once this agent sent 2 of the last 4 Messages, so no two agents
 * keep the floor between them. */
export const SHARE_THRESHOLD = 0.75;
/** How many recent Messages the gate and the model read. */
export const HISTORY_LIMIT = 15;

/** One decision per webhook event, saved before any wait. */
export interface SpeakDecision {
  spoke: boolean;
  readyAt: number;
}

export type SpeakGateResult =
  | { kind: "turn"; history?: string }
  | { kind: "silent" }
  | { kind: "deferred"; seconds: number };

export interface SpeakGateDependencies {
  relay: Pick<Relay, "chats" | "messages">;
  rank: SpeakRanker;
  /** The other agents in this group that run this same gate, by handle. */
  peers: ReadonlySet<string>;
  get(): SpeakDecision | undefined | Promise<SpeakDecision | undefined>;
  put(decision: SpeakDecision): void | Promise<void>;
  now?(): number;
}

/** The fields of a `message.received` webhook the gate reads. */
interface GroupMessageEvent {
  event_type: "message.received";
  data: {
    id: string;
    chat: {
      id: string;
      is_group: boolean;
      owner_handle: { handle: string; display_name?: string | null };
    };
    sender_handle: { is_me?: boolean; kind?: string };
    parts: Array<{ type: string; mention?: string | null }>;
    reply_to?: { message_id: string } | null;
  };
}

function groupMessage(envelope: unknown): GroupMessageEvent["data"] | null {
  const event = envelope as Partial<GroupMessageEvent> | null;
  const data = event?.data;
  if (event?.event_type !== "message.received" || data?.chat?.is_group !== true) return null;
  if (data.sender_handle?.is_me) return null;
  return data;
}

/** What the ranker reads: who is here, the earlier Messages, and the latest
 * one set apart, so the score is about the latest Message and not the whole
 * conversation. */
export function speakState(members: string[], lines: string[]): string {
  const latest = lines.at(-1) ?? "";
  const earlier = lines.slice(0, -1);
  return [
    `Group chat members: ${members.join(", ")}.`,
    ...(earlier.length ? ["", "Earlier messages, context only:", ...earlier] : []),
    "",
    "Latest message:",
    latest,
  ].join("\n");
}

function historyLines(messages: Message[], self: string): string[] {
  return messages.map((message) => `${message.is_from_me
    ? self
    : message.from_handle?.display_name || message.from_handle?.handle || message.from || "someone"}: ${messageSummary(message)}`);
}

/**
 * Decides when this agent takes its turn on a group Message.
 *
 * - A person's Message: every agent takes a turn, and its own model answers
 *   or calls stay_silent. The gate only orders them: an agent the person
 *   mentioned or replied to goes first, then the rest by score, one step
 *   apart, so each reads the replies before it.
 * - A person who mentions this agent, or replies to its Message: a turn now.
 * - Another agent's Message: a turn only when the score clears the
 *   threshold, which rises once this agent has sent 2 of the last 4 Messages.
 *
 * Every agent reads the same Messages and asks the ranker the same question,
 * so all of them agree on the order. If anything fails, the agent takes its
 * turn: a missed reply is worse than an early one.
 */
export async function speakGate(envelope: unknown, deps: SpeakGateDependencies): Promise<SpeakGateResult> {
  const message = groupMessage(envelope);
  if (!message) return { kind: "turn" };
  const now = deps.now ?? Date.now;
  const self = message.chat.owner_handle;
  const selfName = self.display_name || self.handle;
  const fromPerson = message.sender_handle.kind !== "agent";

  const saved = await deps.get();
  if (saved && !saved.spoke) return { kind: "silent" };
  if (saved && saved.readyAt > now()) return { kind: "deferred", seconds: Math.ceil((saved.readyAt - now()) / 1_000) };

  let history: string | undefined;
  try {
    // Read afresh every time, so after a wait the replies of the agents
    // ahead are in the history this agent's model reads.
    const page = await deps.relay.chats.messages.list(message.chat.id, { order: "desc", limit: HISTORY_LIMIT });
    const messages = [...page.data].reverse();
    const lines = historyLines(messages, selfName);
    history = lines.join("\n");
    if (saved) return { kind: "turn", history };

    const mentions = new Set(message.parts.flatMap((part) => part.type === "text" && part.mention ? [part.mention] : []));
    if (fromPerson && mentions.has(self.handle)) {
      await deps.put({ spoke: true, readyAt: now() });
      return { kind: "turn", history };
    }
    if (message.reply_to) {
      const target = messages.find((item) => item.id === message.reply_to!.message_id)
        ?? await deps.relay.messages.retrieve(message.reply_to.message_id);
      if (fromPerson && target.is_from_me) {
        await deps.put({ spoke: true, readyAt: now() });
        return { kind: "turn", history };
      }
      if (target.from_handle?.handle) mentions.add(target.from_handle.handle);
    }

    const chat = await deps.relay.chats.retrieve(message.chat.id);
    const members = chat.handles.filter((handle) => (handle.status ?? "active") === "active");
    // Only agents that run this gate are in the order; an agent without it
    // answers only its own mentions.
    const agents = members.filter((handle) => handle.kind === "agent"
      && handle.handle !== null
      && (handle.handle === self.handle || deps.peers.has(handle.handle)));
    const own = agents.findIndex((handle) => handle.handle === self.handle);
    if (own < 0) throw new Error("This agent is not an active member of the chat");
    const label = (handle: (typeof members)[number]) => handle.display_name || handle.handle || "someone";
    const addressed = agents.map((handle) => mentions.has(handle.handle!));

    // Every peer scores the chat up to the triggering Message, even if a
    // newer one has landed since, so they all agree.
    const upTo = messages.findIndex((item) => item.id === message.id);
    const scored = upTo >= 0 ? lines.slice(0, upTo + 1) : lines;
    const scores = await deps.rank({
      state: speakState(members.map(label), scored),
      latest: scored.at(-1) ?? "",
      agents: agents.map(label),
      addressed,
      fromPerson,
    });
    const score = scores[own]!;

    let decision: SpeakDecision;
    if (fromPerson) {
      const ahead = (index: number) => scores[index]! > score || (scores[index] === score && index < own);
      const rank = agents.filter((_, index) => index !== own && !addressed[index] && ahead(index)).length;
      const waitsForAddressed = !addressed[own] && addressed.some((value, index) => value && index !== own);
      decision = { spoke: true, readyAt: now() + (rank + (waitsForAddressed ? 1 : 0)) * PERSON_STEP_SECONDS * 1_000 };
    } else {
      const mine = messages.slice(-4).filter((item) => item.is_from_me).length;
      const threshold = mine >= 2 ? SHARE_THRESHOLD : AGENT_THRESHOLD;
      const spoke = score >= threshold;
      decision = { spoke, readyAt: now() + (spoke ? Math.round((1 - score) * AGENT_STAGGER_SECONDS) * 1_000 : 0) };
    }
    await deps.put(decision);
    console.log(JSON.stringify({ event: "speak_gate", chat_id: message.chat.id, scores, from_person: fromPerson, ...decision }));
    if (!decision.spoke) return { kind: "silent" };
    const wait = decision.readyAt - now();
    return wait > 0 ? { kind: "deferred", seconds: Math.ceil(wait / 1_000) } : { kind: "turn", history };
  } catch (error) {
    await deps.put({ spoke: true, readyAt: now() });
    console.warn(JSON.stringify({
      event: "speak_gate_fail_open",
      chat_id: message.chat.id,
      error_type: error instanceof Error ? error.name : typeof error,
    }));
    return { kind: "turn", history };
  }
}
