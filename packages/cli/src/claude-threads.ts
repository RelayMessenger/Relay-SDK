import { configPath, type ConfigContext } from "./config.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Claude Agent SDK session ids, kept beside the profile that owns the agent. */
export const claudeThreadsPath = (context: ConfigContext = {}): string =>
  join(dirname(configPath(context)), "claude-threads.json");

/** The agent a set of threads belongs to. */
export interface ClaudeThreadOwner {
  /** The Relay the agent lives on, so staging and production never share a thread. */
  apiURL: string;
  /** The agent that answers, so two agents in one folder never share a thread. */
  handle: string;
}

/** One chat's key in the file: the Relay, the agent, and the chat. */
export const claudeThreadKey = (owner: ClaudeThreadOwner, chatId: string): string =>
  `${owner.apiURL}|${owner.handle}|${chatId}`;

const readThreads = async (path: string): Promise<Record<string, string>> => {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")) as unknown; }
  // A file that is missing, unreadable or not JSON costs the chats their
  // context and nothing else, so it is replaced rather than complained about.
  catch { return {}; }
  const threads = (parsed as { threads?: unknown } | null)?.threads;
  if (threads === null || typeof threads !== "object") return {};
  return Object.fromEntries(
    Object.entries(threads as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const writeThreads = async (path: string, threads: Record<string, string>): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written whole and moved into place, so a bridge that is stopped mid-write
  // leaves the old file rather than half of a new one.
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, threads }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
};

/** The thread ids for one agent, read once and written on every change. */
export interface ClaudeThreadStore {
  /** The thread Claude opened for this chat, if this computer still remembers one. */
  get(chatId: string): string | undefined;
  /** Remembers the thread Claude just opened for this chat. */
  set(chatId: string, threadId: string): Promise<void>;
}

export const openClaudeThreads = async (
  owner: ClaudeThreadOwner,
  context: ConfigContext = {},
): Promise<ClaudeThreadStore> => {
  const path = claudeThreadsPath(context);
  const threads = await readThreads(path);
  return {
    get: (chatId) => threads[claudeThreadKey(owner, chatId)],
    set: async (chatId, threadId) => {
      threads[claudeThreadKey(owner, chatId)] = threadId;
      // Read again before writing: another bridge, for another agent, may own
      // keys in this same file, and they are not this one's to drop.
      await writeThreads(path, { ...await readThreads(path), ...threads });
    },
  };
};
