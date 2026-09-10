import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * The one file the Relay channel for Claude Code reads. Its three names, its
 * folder and its format are the channel's own
 * (packages/claude-code/src/config.ts, `loadConfig` and `parseEnvFile`;
 * packages/claude-code/README.md, "Manual environment fallback"). The folder is
 * owner-only and the file is mode 600, because it holds an agent's token.
 */
export const CHANNEL_ENV_KEYS = ["RELAY_AGENT_TOKEN", "RELAY_BASE_URL", "RELAY_ALLOWED_SENDERS"] as const;
export const CHANNEL_DIR_MODE = 0o700;
export const CHANNEL_FILE_MODE = 0o600;

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
 * Rewrites only Relay's own three names, in place. Every other line a person or
 * another tool put in this file is kept exactly where it was.
 */
export const renderChannelEnv = (existing: string, values: ChannelEnvValues): string => {
  const changes: Record<string, string> = {
    RELAY_AGENT_TOKEN: values.token,
    RELAY_BASE_URL: values.baseURL,
    RELAY_ALLOWED_SENDERS: [...new Set(values.allowedSenders.map((sender) => sender.trim()).filter(Boolean))].join(","),
  };
  const lines = existing ? existing.split(/\r?\n/u) : [];
  const written = new Set<string>();
  const output = lines.map((line) => {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line.trim());
    const key = match?.[1];
    if (!key || !Object.hasOwn(changes, key) || written.has(key)) return line;
    written.add(key);
    return `${key}=${quoted(changes[key]!)}`;
  });
  for (const key of CHANNEL_ENV_KEYS) {
    if (written.has(key)) continue;
    if (output.at(-1) === "") output.pop();
    output.push(`${key}=${quoted(changes[key]!)}`);
  }
  if (output.at(-1) !== "") output.push("");
  return output.join(existing.includes("\r\n") ? "\r\n" : "\n");
};

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
 * Writes the file through a private temporary file in the same folder, so a
 * reader never sees a half-written token and the token never exists in a
 * world-readable file for even an instant.
 */
export const writeChannelEnv = async (
  channelDir: string,
  values: ChannelEnvValues,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; contents: string }> => {
  const state = await inspectChannelEnv(channelDir);
  const contents = renderChannelEnv(state.contents, values);
  await mkdir(channelDir, { recursive: true, mode: CHANNEL_DIR_MODE });
  if (platform !== "win32") await chmod(channelDir, CHANNEL_DIR_MODE);
  const temporary = join(channelDir, `.relay-connect-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", CHANNEL_FILE_MODE);
  try {
    try {
      await handle.writeFile(contents, "utf8");
      if (platform !== "win32") await handle.chmod(CHANNEL_FILE_MODE);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, state.path);
    if (platform !== "win32") await chmod(state.path, CHANNEL_FILE_MODE);
    return { path: state.path, contents };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};
