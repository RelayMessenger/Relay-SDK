import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { CODING_AGENTS, claudeConfigDir, type CodingAgentId, type AgentPaths } from "./coding-agents.js";

export { claudeConfigDir } from "./coding-agents.js";
export type RuntimeId = CodingAgentId;

export interface RuntimeSniffContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
}

export interface RuntimeFound {
  id: RuntimeId;
  label: string;
  /** Full path to the agent's own command, when it is on PATH. */
  executable?: string;
  /** The agent's own folder or file, when it is already on this computer. */
  configPath?: string;
  /** Either signal is enough: an installed command, or the folder it keeps. */
  found: boolean;
}

export const claudeChannelDir = (env: NodeJS.ProcessEnv, home: string): string => {
  const configured = env.RELAY_CHANNEL_DIR?.trim();
  return configured ? configured : join(claudeConfigDir(env, home), "channels", "relay");
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

/**
 * Which agents are on this computer: the registry's install paths (Docker's
 * `os.Stat` on each `installCheckPaths` entry, first hit wins), plus the
 * agent's own command on PATH when it has one. Nothing is run.
 */
export const sniffRuntimes = async (context: RuntimeSniffContext): Promise<RuntimeFound[]> => {
  const platform = context.platform ?? process.platform;
  const paths: AgentPaths = { env: context.env, home: context.home, platform };
  const runtimes: RuntimeFound[] = [];
  for (const agent of CODING_AGENTS) {
    const executable = agent.command ? await findExecutable(agent.command, context.env, platform) : undefined;
    let configPath: string | undefined;
    for (const candidate of agent.installedIf(paths)) {
      if (candidate && await pathExists(candidate)) { configPath = candidate; break; }
    }
    runtimes.push({
      id: agent.id,
      label: agent.label,
      ...(executable ? { executable } : {}),
      ...(configPath ? { configPath } : {}),
      found: Boolean(executable) || configPath !== undefined,
    });
  }
  return runtimes;
};
