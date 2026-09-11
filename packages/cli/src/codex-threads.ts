import { configPath, type ConfigContext } from "./config.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Which Codex thread belongs to which Relay chat, kept where the profile that
 * owns the agent is kept.
 *
 * `codex app-server` keeps a thread for as long as its rollout file exists, and
 * takes that thread back by id (`thread/resume`). The bridge is the only thing
 * that knows which thread belongs to which chat, and it forgot on every restart
 * while the ids lived in memory. They live here instead, beside
 * `config.json`, so a chat keeps its context across restarts of the bridge and
 * of Codex itself.
 */
export const codexThreadsPath = (context: ConfigContext = {}): string =>
  join(dirname(configPath(context)), "codex-threads.json");

/** The agent a set of threads belongs to. */
export interface CodexThreadOwner {
  /** The Relay the agent lives on, so staging and production never share a thread. */
  apiURL: string;
  /** The agent that answers, so two agents in one folder never share a thread. */
  handle: string;
}

/** One chat's key in the file: the Relay, the agent, and the chat. */
export const codexThreadKey = (owner: CodexThreadOwner, chatId: string): string =>
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
export interface CodexThreadStore {
  /** The thread Codex opened for this chat, if this computer still remembers one. */
  get(chatId: string): string | undefined;
  /** Remembers the thread Codex just opened for this chat. */
  set(chatId: string, threadId: string): Promise<void>;
}

export const openCodexThreads = async (
  owner: CodexThreadOwner,
  context: ConfigContext = {},
): Promise<CodexThreadStore> => {
  const path = codexThreadsPath(context);
  const threads = await readThreads(path);
  return {
    get: (chatId) => threads[codexThreadKey(owner, chatId)],
    set: async (chatId, threadId) => {
      threads[codexThreadKey(owner, chatId)] = threadId;
      // Read again before writing: another bridge, for another agent, may own
      // keys in this same file, and they are not this one's to drop.
      await writeThreads(path, { ...await readThreads(path), ...threads });
    },
  };
};
