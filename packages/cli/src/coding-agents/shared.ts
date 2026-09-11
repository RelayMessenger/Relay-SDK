import { posix, win32 } from "node:path";
import type { AgentPaths, CodingAgentId, ConnectMethod } from "../coding-agents.js";

export const platformPath = (platform: NodeJS.Platform) => platform === "win32" ? win32 : posix;

export const appData = (paths: AgentPaths): string => paths.env.APPDATA?.trim() || win32.join(paths.home, "AppData", "Roaming");
export const configHome = (paths: AgentPaths): string => platformPath(paths.platform).join(paths.home, ".config");
export const appSupport = (paths: AgentPaths): string => posix.join(paths.home, "Library", "Application Support");

/**
 * `CLAUDE_CONFIG_DIR` replaces the default folder rather than adding to it. The
 * Relay channel resolves the same way, so both sides always read one file
 * (packages/claude-code/src/config.ts, `defaultChannelDir`).
 */
export const claudeConfigDir = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string => {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : platformPath(platform).join(home, ".claude");
};
export const codexHome = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string => {
  const configured = env.CODEX_HOME?.trim();
  return configured ? configured : platformPath(platform).join(home, ".codex");
};
export const hermesHome = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string => {
  const configured = env.HERMES_HOME?.trim();
  return configured ? configured : platformPath(platform).join(home, ".hermes");
};
export const openclawHome = (home: string, platform: NodeJS.Platform = process.platform): string => platformPath(platform).join(home, ".openclaw");

/** Per-OS config files, quoted from Docker's registry (`paths:` per client). */
export const byPlatform = (paths: AgentPaths, files: { darwin: string; win32: string; linux: string }): string =>
  paths.platform === "darwin" ? files.darwin : paths.platform === "win32" ? files.win32 : files.linux;


export interface CodingAgent {
  id: CodingAgentId;
  label: string;
  /** Other words a person may type for it; the id itself always works. */
  aliases: readonly string[];
  /** Its own command on PATH, when Relay runs one or names one. */
  command?: string;
  /** Installed when any of these exists. Empty strings are skipped. */
  installedIf: (paths: AgentPaths) => string[];
  connect: ConnectMethod;
  start?:
    | { kind: "command"; command: string; args: string[]; prompt: string }
    | { kind: "restart"; instruction: string };
  /** What `@vercel/detect-agent` calls it when we are running inside it. */
  detectedAs: readonly string[];
}
