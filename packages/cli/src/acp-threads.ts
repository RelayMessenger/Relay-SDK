import { configPath, type ConfigContext } from "./config.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Which ACP session belongs to which Relay chat, kept where the profile that
 * owns the agent is kept.
 *
 * An ACP agent (cursor, gemini-cli, opencode) gives every `session/new` a
 * session id, and takes an old one back with `session/load` when it advertises
 * that it can (`agentCapabilities.loadSession`). The bridge is the only thing
 * that knows which session belongs to which chat, and it would forget on every
 * restart while the ids lived in memory. They live here instead, beside
 * `config.json`, so a chat keeps its context across restarts of the bridge and
 * of the agent itself. This is the shape `codex-threads.ts` uses for Codex,
 * kept in its own file so the two never share a key.
 */
export const acpSessionsPath = (context: ConfigContext = {}): string =>
  join(dirname(configPath(context)), "acp-sessions.json");

/** The agent a set of sessions belongs to. */
export interface AcpSessionOwner {
  /** The Relay the agent lives on, so staging and production never share a session. */
  apiURL: string;
  /** The agent that answers, so two agents in one folder never share a session. */
  handle: string;
}

/** One chat's key in the file: the Relay, the agent, and the chat. */
export const acpSessionKey = (owner: AcpSessionOwner, chatId: string): string =>
  `${owner.apiURL}|${owner.handle}|${chatId}`;

const readSessions = async (path: string): Promise<Record<string, string>> => {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")) as unknown; }
  // A file that is missing, unreadable or not JSON costs the chats their
  // context and nothing else, so it is replaced rather than complained about.
  catch { return {}; }
  const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
  if (sessions === null || typeof sessions !== "object") return {};
  return Object.fromEntries(
    Object.entries(sessions as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const writeSessions = async (path: string, sessions: Record<string, string>): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written whole and moved into place, so a bridge that is stopped mid-write
  // leaves the old file rather than half of a new one.
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
};

/** The session ids for one agent, read once and written on every change. */
export interface AcpSessionStore {
  /** The session the agent opened for this chat, if this computer still remembers one. */
  get(chatId: string): string | undefined;
  /** Remembers the session the agent just opened for this chat. */
  set(chatId: string, sessionId: string): Promise<void>;
}

export const openAcpSessions = async (
  owner: AcpSessionOwner,
  context: ConfigContext = {},
): Promise<AcpSessionStore> => {
  const path = acpSessionsPath(context);
  const sessions = await readSessions(path);
  return {
    get: (chatId) => sessions[acpSessionKey(owner, chatId)],
    set: async (chatId, sessionId) => {
      sessions[acpSessionKey(owner, chatId)] = sessionId;
      // Read again before writing: another bridge, for another agent, may own
      // keys in this same file, and they are not this one's to drop.
      await writeSessions(path, { ...await readSessions(path), ...sessions });
    },
  };
};
