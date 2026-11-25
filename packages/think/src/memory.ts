// @relaymessenger/think/memory: a Think agent remembers what a person and
// it said across every Chat they share (owner, 2026-10-08: "The agent's
// memory should sync with the user, not the chat").
//
// - RelayPersonMemory is a Durable Object, one instance per person, named
//   `person:<personId>` (Per-User Agents routing, agents docs/routing.md).
//   It indexes lines in an AgentSearchProvider (agents docs/context.md).
// - personMemory(agent, options) wires a Think agent to it: `ingest()` after
//   each turn stores the Chat's new lines, `turn()` in beforeTurn adds one
//   model Message with the person's other Chats and a search tool.
//
// It loads `agents`, which needs the Workers runtime, so it is its own entry.
import type Relay from "@relaymessenger/sdk";
import { RelayAPIError } from "@relaymessenger/sdk";
import { Agent, getAgentByName } from "agents";
import { AgentSearchProvider } from "agents/context";
import { type ModelMessage, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";

import {
  chatLabel,
  memberHandle,
  personMemoryContent,
  personMemoryLines,
  personMemoryName,
  personMemoryReader,
  personMemoryRow,
  personMemoryWrites,
  relayChatRows,
  type PersonMemoryChat,
  type PersonMemoryRecall,
} from "./person-memory.js";

export {
  chatLabel,
  chatPeople,
  personMemoryContent,
  personMemoryLines,
  personMemoryName,
  personMemoryReader,
  personMemoryRow,
  personMemoryWrites,
  relayChatRows,
  type PersonMemoryChat,
  type PersonMemoryLine,
  type PersonMemoryRecall,
} from "./person-memory.js";

/** Lines of each other Chat a turn reads, newest kept. */
export const PERSON_MEMORY_CHAT_LINES = 20;
/** Other Chats a turn reads, most recent first. */
export const PERSON_MEMORY_CHATS = 5;
/** Messages of each other Chat a turn reads from Relay, when `relay` is set. */
export const PERSON_MEMORY_RELAY_MESSAGES = 30;
const PERSON_MEMORY_RELAY_TIMEOUT_MS = 5_000;
const INDEX_LABEL = "person_memory";

function relayCallSignal(turnSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PERSON_MEMORY_RELAY_TIMEOUT_MS);
  return turnSignal ? AbortSignal.any([turnSignal, timeout]) : timeout;
}

function isRevokedAccessError(error: unknown): boolean {
  if (error instanceof RelayAPIError) {
    return error.status === 403 || error.status === 404;
  }
  return false;
}

interface StoredChat {
  chat_id: string;
  label: string;
  recent: string;
  updated_at: string;
}

/** One person's memory: an index of their lines, and each Chat's latest lines. */
export class RelayPersonMemory extends Agent {
  #index?: AgentSearchProvider;

  #search(): AgentSearchProvider {
    if (!this.#index) {
      this.#index = new AgentSearchProvider(this);
      this.#index.init(INDEX_LABEL);
      this.sql`CREATE TABLE IF NOT EXISTS relay_person_memory_chats (
        chat_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        recent TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
    }
    return this.#index;
  }

  /** Store a Chat's lines, each under `<chatId>:<messageId>`. */
  async remember(
    chatId: string,
    label: string,
    rows: ReadonlyArray<{ key: string; content: string; at: string }>,
  ): Promise<void> {
    if (!rows.length) return;
    const index = this.#search();
    for (const row of rows) await index.set(row.key, row.content);
    const stored = this.sql<StoredChat>`
      SELECT * FROM relay_person_memory_chats WHERE chat_id = ${chatId}
    `[0];
    const seen = new Set(rows.map((row) => row.key));
    const previous = stored
      ? (JSON.parse(stored.recent) as Array<{ key: string; content: string }>)
        .filter((row) => !seen.has(row.key))
      : [];
    const recent = [...previous, ...rows.map(({ key, content }) => ({ key, content }))]
      .slice(-PERSON_MEMORY_CHAT_LINES);
    const updatedAt = rows.at(-1)!.at;
    this.sql`INSERT INTO relay_person_memory_chats (chat_id, label, recent, updated_at)
      VALUES (${chatId}, ${label}, ${JSON.stringify(recent)}, ${updatedAt})
      ON CONFLICT(chat_id) DO UPDATE SET
        label = excluded.label, recent = excluded.recent, updated_at = excluded.updated_at`;
  }

  /** Remove all stored lines and search index entries for a Chat this person can no longer access. */
  async forget(chatId: string): Promise<void> {
    const index = this.#search();
    this.sql`DELETE FROM relay_person_memory_chats WHERE chat_id = ${chatId}`;
    // Ensure the FTS5 table exists before deleting matching chat keys.
    await index.get();
    const prefix = `${chatId}:`;
    this.sql`DELETE FROM cf_agents_search_fts
      WHERE label = ${INDEX_LABEL}
        AND substr(key, 1, ${prefix.length}) = ${prefix}`;
  }

  /** Up to 10 ranked hits with their owning chatId, without the excluded Chats'. */
  async searchEntries(
    query: string,
    exceptChatIds?: string | readonly string[],
  ): Promise<Array<{ chatId: string; content: string }>> {
    const found = await this.#search().search(query);
    if (!found) return [];
    const excluded = new Set(
      exceptChatIds === undefined
        ? []
        : typeof exceptChatIds === "string"
        ? [exceptChatIds]
        : exceptChatIds,
    );
    // AgentSearchProvider renders each hit as `[<key>]\n<content>`, hits
    // joined by a blank line; a stored row is always one line.
    return found.split("\n\n").flatMap((hit) => {
      const match = /^\[([^\]]*)\]\n(.*)$/su.exec(hit);
      if (!match) return [];
      const key = match[1]!;
      const separator = key.indexOf(":");
      const chatId = separator >= 0 ? key.slice(0, separator) : key;
      if (excluded.has(chatId)) return [];
      return [{ chatId, content: match[2]! }];
    });
  }

  /** Up to 10 ranked lines for a query, without the given Chat's. */
  async search(query: string, exceptChatId?: string | readonly string[]): Promise<string[]> {
    return (await this.searchEntries(query, exceptChatId)).map((entry) => entry.content);
  }

  /** The person's other Chats, most recent first, and hits for the query. */
  async recall(chatId: string, query: string): Promise<PersonMemoryRecall> {
    this.#search();
    const chats = this.sql<StoredChat>`
      SELECT * FROM relay_person_memory_chats
      WHERE chat_id != ${chatId}
      ORDER BY updated_at DESC
      LIMIT ${PERSON_MEMORY_CHATS}
    `.map((chat) => ({
      chatId: chat.chat_id,
      label: chat.label,
      lines: (JSON.parse(chat.recent) as Array<{ content: string }>).map((row) => row.content),
    }));
    const shown = new Set(chats.flatMap((chat) => chat.lines));
    const hits = query.trim()
      ? (await this.search(query, chatId)).filter((hit) => !shown.has(hit))
      : [];
    return { chats, hits };
  }
}

/** The Durable Object namespace a Worker binds RelayPersonMemory under. */
export interface RelayPersonMemoryNamespace {
  idFromName(name: string): unknown;
  get(id: never): unknown;
}

export interface PersonMemoryOptions {
  /** `false` turns memory off. */
  personMemory?: boolean;
  /** The binding of RelayPersonMemory; memory is off without one. */
  binding: RelayPersonMemoryNamespace | undefined;
  /** This turn's Chat, as GET /v1/chats/{chatId} returns it. */
  chat(): Promise<PersonMemoryChat | undefined>;
  /** Set when one Worker runs several agents: `person:<agentId>:<personId>`. */
  agentId?: string;
  /**
   * A Relay client (`new Relay(...)` from @relaymessenger/sdk). When set, a
   * turn reads each other Chat's recent Messages from Relay, so it sees the
   * whole talk of a group, not only the lines this agent took in.
   */
  relay?: Pick<Relay, "chats">;
}

/** What a Think agent needs from itself: its stored history. */
export interface PersonMemoryAgent {
  readonly messages: UIMessage[];
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

type PersonMemoryStub = Pick<RelayPersonMemory, "remember" | "recall" | "search"> & {
  forget?: RelayPersonMemory["forget"];
  searchEntries?: RelayPersonMemory["searchEntries"];
};

export interface PersonMemory {
  readonly enabled: boolean;
  /**
   * Store the Chat's lines that are new since the last call, each in the
   * memory of the person it belongs to. Call it after every turn
   * (onChatResponse).
   */
  ingest(): Promise<void>;
  /**
   * In beforeTurn: the turn's messages with the person's memory added as one
   * model Message before the newest, and the `search_person_memory` tool.
   * Returns nothing in a Chat with two or more people.
   */
  turn(
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ messages: ModelMessage[]; tools: ToolSet } | undefined>;
}

const OFF: PersonMemory = {
  enabled: false,
  ingest: async () => {},
  turn: async () => undefined,
};

function lastUserText(messages: readonly ModelMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ");
}

/** Wire a Think agent to per-person memory. Off unless a binding is given. */
export function personMemory(agent: PersonMemoryAgent, options: PersonMemoryOptions): PersonMemory {
  const binding = options.binding;
  if (options.personMemory === false || !binding) return OFF;
  const stub = (personId: string) =>
    getAgentByName(
      binding as never,
      personMemoryName(personId, options.agentId),
    ) as unknown as Promise<PersonMemoryStub>;
  let cursorReady = false;
  const cursor = {
    read(chatId: string): string | undefined {
      if (!cursorReady) {
        agent.sql`CREATE TABLE IF NOT EXISTS relay_person_memory_cursor (
          chat_id TEXT PRIMARY KEY, last_key TEXT NOT NULL
        )`;
        cursorReady = true;
      }
      return agent.sql<{ last_key: string }>`
        SELECT last_key FROM relay_person_memory_cursor WHERE chat_id = ${chatId}
      `[0]?.last_key;
    },
    write(chatId: string, key: string): void {
      agent.sql`INSERT INTO relay_person_memory_cursor (chat_id, last_key)
        VALUES (${chatId}, ${key})
        ON CONFLICT(chat_id) DO UPDATE SET last_key = excluded.last_key`;
    },
  };

  return {
    enabled: true,
    async ingest() {
      const chat = await options.chat();
      if (!chat) return;
      const lines = personMemoryLines(chat, agent.messages);
      if (!lines.length) return;
      // The cursor pass: only lines after the last one stored. A cursor no
      // longer in history (compacted) stores everything again; `set` keys
      // by line, so that rewrites rows rather than duplicating them.
      const last = cursor.read(chat.id);
      const from = last === undefined ? 0 : lines.findIndex((line) => line.key === last) + 1;
      const fresh = lines.slice(from);
      if (!fresh.length) return;
      const freshKeys = new Set(fresh.map((line) => line.key));
      const label = chatLabel(chat);
      for (const [person, own] of personMemoryWrites(chat, lines)) {
        const rows = own
          .filter((line) => freshKeys.has(line.key))
          .map((line) => ({ key: line.key, content: personMemoryRow(label, line), at: line.at }));
        if (rows.length) await (await stub(person)).remember(chat.id, label, rows);
      }
      cursor.write(chat.id, fresh.at(-1)!.key);
    },
    async turn(messages, signal) {
      const chat = await options.chat();
      if (!chat) return undefined;
      const person = personMemoryReader(chat, personMemoryLines(chat, agent.messages));
      if (!person) return undefined;
      const memory = await stub(person);
      const relay = options.relay;
      const queryText = lastUserText(messages);
      const recall = await memory.recall(chat.id, relay ? "" : queryText);
      const excludedChatIds = new Set<string>([chat.id]);
      const verifiedChatIds = new Set<string>();

      const purgeChat = async (targetChatId: string): Promise<void> => {
        excludedChatIds.add(targetChatId);
        try {
          await memory.forget?.(targetChatId);
        } catch {
          // Best-effort purge; excludedChatIds still blocks it for this turn.
        }
      };

      const verifyMembership = async (
        targetChatId: string,
        turnSignal?: AbortSignal,
      ): Promise<{ status: "allowed"; chat: PersonMemoryChat } | { status: "denied" } | { status: "transient" }> => {
        if (!relay) return { status: "transient" };
        try {
          const current = await relay.chats.retrieve(targetChatId, {
            signal: relayCallSignal(turnSignal),
            maxRetries: 0,
          }) as PersonMemoryChat;
          if (!memberHandle(current, person)) {
            await purgeChat(targetChatId);
            return { status: "denied" };
          }
          return { status: "allowed", chat: current };
        } catch (error) {
          if (isRevokedAccessError(error)) {
            await purgeChat(targetChatId);
            return { status: "denied" };
          }
          return { status: "transient" };
        }
      };

      const verifiedSearch = async (query: string, turnSignal?: AbortSignal): Promise<string[]> => {
        if (!query.trim()) return [];
        if (!relay) return await memory.search(query, chat.id);
        if (!memory.searchEntries) return await memory.search(query, [...excludedChatIds]);
        const entries = await memory.searchEntries(query, [...excludedChatIds]);
        const unverified = [...new Set(
          entries
            .map((entry) => entry.chatId)
            .filter((chatId) => !verifiedChatIds.has(chatId) && !excludedChatIds.has(chatId)),
        )];
        await Promise.all(unverified.map(async (targetChatId) => {
          const verdict = await verifyMembership(targetChatId, turnSignal);
          if (verdict.status === "allowed") verifiedChatIds.add(targetChatId);
        }));
        return entries
          .filter((entry) => !excludedChatIds.has(entry.chatId))
          .map((entry) => entry.content);
      };

      if (relay) {
        // Each other Chat as Relay holds it, in parallel. A Chat the person
        // is no longer in, or one returning 403/404, is excluded and purged;
        // transient network/5xx errors keep the stored lines.
        const read = await Promise.all(recall.chats.map(async (stored) => {
          const verdict = await verifyMembership(stored.chatId, signal);
          if (verdict.status === "denied") return undefined;
          if (verdict.status === "transient") return stored;
          try {
            const page = await relay.chats.messages.list(stored.chatId, {
              order: "desc",
              limit: PERSON_MEMORY_RELAY_MESSAGES,
            }, {
              signal: relayCallSignal(signal),
              maxRetries: 0,
            });
            verifiedChatIds.add(stored.chatId);
            return {
              ...stored,
              label: chatLabel(verdict.chat),
              lines: relayChatRows(verdict.chat, page.data, person),
            };
          } catch (error) {
            if (isRevokedAccessError(error)) {
              await purgeChat(stored.chatId);
              return undefined;
            }
            return stored;
          }
        }));
        recall.chats = read.filter((entry) => entry !== undefined);
        const shown = new Set(recall.chats.flatMap((entry) => entry.lines));
        const hits = await verifiedSearch(queryText, signal);
        recall.hits = hits.filter((hit) => !shown.has(hit));
      }
      const tools: ToolSet = {
        search_person_memory: tool({
          description:
            "Search what this person and you said in your other chats with them. Returns up to 10 matching lines.",
          inputSchema: z.object({ query: z.string().trim().min(1).max(200) }),
          execute: async ({ query }, toolOptions) => ({
            lines: await verifiedSearch(query, toolOptions?.abortSignal ?? signal),
          }),
        }),
      };
      const content = personMemoryContent(recall);
      if (!content) return { messages, tools };
      const newest = messages.length - 1;
      const memoryMessage: ModelMessage = { role: "user", content };
      return {
        messages: newest >= 0
          ? [...messages.slice(0, newest), memoryMessage, messages[newest]!]
          : [memoryMessage],
        tools,
      };
    },
  };
}
