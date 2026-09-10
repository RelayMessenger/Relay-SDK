import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The runtimes this build knows about. The connect menu is built from this
 * registry and from what is on the machine, so adding a runtime later is a new
 * entry here, never a new row hard-coded into a menu.
 */
export type RuntimeId = "claude" | "hermes" | "openclaw";
/** "other" is the menu's "Something else": any backend, by token or from code. */
export type RuntimeChoice = RuntimeId | "other";

export interface RuntimeSniffContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
}

export interface RuntimeFound {
  id: RuntimeId;
  label: string;
  /** Full path to the runtime's own command, when it is on PATH. */
  executable?: string;
  /** The runtime's own folder or file, when it is already on this computer. */
  configPath?: string;
  /** Either signal is enough: an installed command, or the folder it keeps. */
  found: boolean;
  /** Only Claude Code is written by this build; the others detect and stop. */
  supported: boolean;
}

export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  claude: "Claude Code",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};
const RUNTIME_COMMANDS: Record<RuntimeId, string> = {
  claude: "claude",
  hermes: "hermes",
  openclaw: "openclaw",
};
const SUPPORTED: Record<RuntimeId, boolean> = { claude: true, hermes: false, openclaw: false };

/**
 * `CLAUDE_CONFIG_DIR` replaces the default folder rather than adding to it. The
 * Relay channel resolves the same way, so both sides always read one file
 * (packages/claude-code/src/config.ts, `defaultChannelDir`).
 */
export const claudeConfigDir = (env: NodeJS.ProcessEnv, home: string): string => {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(home, ".claude");
};
export const claudeChannelDir = (env: NodeJS.ProcessEnv, home: string): string => {
  const configured = env.RELAY_CHANNEL_DIR?.trim();
  return configured ? configured : join(claudeConfigDir(env, home), "channels", "relay");
};

/** The one path whose presence says the runtime has been on this computer. */
export const runtimeConfigPath = (id: RuntimeId, context: RuntimeSniffContext): string => {
  if (id === "claude") return claudeConfigDir(context.env, context.home);
  if (id === "hermes") {
    const configured = context.env.HERMES_HOME?.trim();
    return configured ? configured : join(context.home, ".hermes");
  }
  return join(context.home, ".openclaw", "openclaw.json");
};

/** Only explicit absolute PATH entries are searched; the working folder is never one. */
export const findExecutable = async (
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> => {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const raw of pathValue.split(delimiter)) {
    const directory = raw.replace(/^"(.*)"$/u, "$1");
    if (!isAbsolute(directory)) continue;
    const path = join(directory, platform === "win32" ? `${name}.cmd` : name);
    try {
      await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return path;
    } catch { /* Try the next explicit PATH entry. */ }
  }
  return undefined;
};

const pathExists = async (path: string): Promise<boolean> => {
  try { await stat(path); return true; } catch { return false; }
};

export const sniffRuntimes = async (context: RuntimeSniffContext): Promise<RuntimeFound[]> => {
  const platform = context.platform ?? process.platform;
  const runtimes: RuntimeFound[] = [];
  for (const id of Object.keys(RUNTIME_LABELS) as RuntimeId[]) {
    const executable = await findExecutable(RUNTIME_COMMANDS[id], context.env, platform);
    const configPath = runtimeConfigPath(id, context);
    const configured = await pathExists(configPath);
    runtimes.push({
      id,
      label: RUNTIME_LABELS[id],
      ...(executable ? { executable } : {}),
      ...(configured ? { configPath } : {}),
      found: Boolean(executable) || configured,
      supported: SUPPORTED[id],
    });
  }
  return runtimes;
};

/** What the person saw that says this runtime is here: its version, or its folder. */
export const runtimeEvidence = (runtime: RuntimeFound, version?: string): string =>
  version ? version : runtime.executable ?? runtime.configPath ?? "on this computer";

/** Accepts the short word a person types, and the runtime's own full name. */
export const normalizeRuntimeChoice = (value: string): RuntimeChoice | undefined => {
  const normalized = value.trim().toLowerCase();
  if (["claude", "claude-code", "claudecode"].includes(normalized)) return "claude";
  if (normalized === "hermes") return "hermes";
  if (["openclaw", "open-claw"].includes(normalized)) return "openclaw";
  if (["other", "something-else", "sdk"].includes(normalized)) return "other";
  return undefined;
};
