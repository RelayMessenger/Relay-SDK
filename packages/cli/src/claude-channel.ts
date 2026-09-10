import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, preparePrivateDestination, writePrivateDestination } from "./private-file.js";

/**
 * The one file the Relay channel for Claude Code reads. Its three names, its
 * folder and its format are the channel's own
 * (packages/claude-code/src/config.ts, `loadConfig` and `parseEnvFile`;
 * packages/claude-code/README.md, "Manual environment fallback"). The folder is
 * owner-only and the file is mode 600, because it holds an agent's token.
 */
export const CHANNEL_ENV_KEYS = ["RELAY_AGENT_TOKEN", "RELAY_BASE_URL", "RELAY_ALLOWED_SENDERS"] as const;
export const CHANNEL_DIR_MODE = PRIVATE_DIR_MODE;
export const CHANNEL_FILE_MODE = PRIVATE_FILE_MODE;

export interface ChannelEnvValues {
  token: string;
  baseURL: string;
  /** Handles or Contact ids allowed to message this agent. */
  allowedSenders: readonly string[];
}

/** The channel's own reader: last line wins, quotes optional, `export` allowed. */
export const readChannelEnv = (contents: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const original of contents.split(/\r?\n/u)) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
};

const quoted = (value: string): string => {
  if (/[\r\n\s"'`$\\]/u.test(value)) {
    throw new Error("That value cannot be written to a .env file safely. Use a value with no quotes, backticks, dollar signs, backslashes or line breaks.");
  }
  return `"${value}"`;
};

/**
 * Rewrites only the named keys, in place. Every other line a person or another
 * tool put in this file is kept exactly where it was. Shared by every runtime
 * that keeps its Relay settings in a .env file (Claude Code, Hermes).
 */
export const renderEnvFile = (existing: string, changes: Record<string, string>): string => {
  const lines = existing ? existing.split(/\r?\n/u) : [];
  const written = new Set<string>();
  const output = lines.map((line) => {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line.trim());
    const key = match?.[1];
    if (!key || !Object.hasOwn(changes, key) || written.has(key)) return line;
    written.add(key);
    return `${key}=${quoted(changes[key]!)}`;
  });
  for (const key of Object.keys(changes)) {
    if (written.has(key)) continue;
    if (output.at(-1) === "") output.pop();
    output.push(`${key}=${quoted(changes[key]!)}`);
  }
  if (output.at(-1) !== "") output.push("");
  return output.join(existing.includes("\r\n") ? "\r\n" : "\n");
};

export const renderChannelEnv = (existing: string, values: ChannelEnvValues): string => renderEnvFile(existing, {
  RELAY_AGENT_TOKEN: values.token,
  RELAY_BASE_URL: values.baseURL,
  RELAY_ALLOWED_SENDERS: [...new Set(values.allowedSenders.map((sender) => sender.trim()).filter(Boolean))].join(","),
});

export interface ChannelEnvState {
  path: string;
  exists: boolean;
  /** The token already in the file, when it holds one. Never printed. */
  token?: string;
  baseURL?: string;
  allowedSenders: string[];
  contents: string;
}

export const inspectChannelEnv = async (channelDir: string): Promise<ChannelEnvState> => {
  const path = join(channelDir, ".env");
  let contents = "";
  let exists = false;
  try { contents = await readFile(path, "utf8"); exists = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values = readChannelEnv(contents);
  return {
    path,
    exists,
    ...(values.RELAY_AGENT_TOKEN ? { token: values.RELAY_AGENT_TOKEN } : {}),
    ...(values.RELAY_BASE_URL ? { baseURL: values.RELAY_BASE_URL } : {}),
    allowedSenders: (values.RELAY_ALLOWED_SENDERS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    contents,
  };
};

/**
 * Writes the file the way the Relay config is written (private-file.ts): an
 * exclusive temporary file in the same folder, private before the token lands
 * in it, renamed over the destination, read back. Owner-only by the platform's
 * own means: mode bits on POSIX, a private ACL on Windows.
 */
export const writeChannelEnv = async (
  channelDir: string,
  values: ChannelEnvValues,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; contents: string }> => {
  const state = await inspectChannelEnv(channelDir);
  const contents = renderChannelEnv(state.contents, values);
  const destination = await preparePrivateDestination(state.path, "Claude Code channel", platform);
  await writePrivateDestination(destination, ".relay-connect", contents);
  return { path: state.path, contents };
};

/** The same private write for any runtime's .env file: only the named keys change. */
export const writeEnvFile = async (
  path: string,
  changes: Record<string, string>,
  label: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; contents: string }> => {
  let existing = "";
  try { existing = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const contents = renderEnvFile(existing, changes);
  const destination = await preparePrivateDestination(path, label, platform);
  await writePrivateDestination(destination, ".relay-connect", contents);
  return { path, contents };
};
