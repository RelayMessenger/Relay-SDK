import claudeCode from "./coding-agents/claude-code.js";
import codex from "./coding-agents/codex.js";
import cursor from "./coding-agents/cursor.js";
import opencode from "./coding-agents/opencode.js";
import cline from "./coding-agents/cline.js";
import vscode from "./coding-agents/vscode.js";
import geminiCli from "./coding-agents/gemini-cli.js";
import claudeDesktop from "./coding-agents/claude-desktop.js";
import hermes from "./coding-agents/hermes.js";
import openclaw from "./coding-agents/openclaw.js";
export { platformPath, claudeConfigDir, codexHome, hermesHome, openclawHome } from "./coding-agents/shared.js";


/**
 * The ten coding agents `connect` knows, in the order the help lists them. This
 * is the one table: detection, the "Supported agents" line, the prompt, the
 * plan and the tests all read it, so the list cannot drift between screens.
 *
 * Ruled 2026-09-10 (_artifacts/cli-connect-targets-20260910): an agent ships
 * when at least three of the seven installers that publish a target list carry
 * it; Hermes and OpenClaw ship because the plugins are ours. Identifiers are
 * the ones Smithery and Docker MCP share, Docker's where they differ; `claude`
 * stays as an alias of `claude-code` so this week's docs and scripts keep
 * working. Install checks are Docker's `installCheckPaths`
 * (docker/mcp-gateway pkg/client/config.yml) and Vercel's `detect(home)`
 * (vercel/vercel packages/cli/src/util/ai-gateway/coding-agents/agents/*):
 * does the agent's own folder exist under home. No binaries are run.
 */
export type CodingAgentId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "opencode"
  | "cline"
  | "vscode"
  | "gemini-cli"
  | "claude-desktop"
  | "hermes"
  | "openclaw";

export interface AgentPaths {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

/**
 * How Relay reaches the agent once its token is saved on this computer.
 * - `claude-plugin`: the Relay channel plugin for Claude Code, as today.
 * - `mcp-command`: the agent's own `mcp add` writes its config.
 * - `mcp-file`: Relay adds one entry to the agent's MCP config file.
 * - `hermes-plugin`, `openclaw-plugin`: our plugins, as Relay-Docs describe.
 */
export type ConnectMethod =
  | { kind: "claude-plugin" }
  | { kind: "mcp-command"; file: (paths: AgentPaths) => string }
  | { kind: "mcp-file"; file: (paths: AgentPaths) => string; shape: "mcpServers" | "vscode" | "opencode" }
  | { kind: "hermes-plugin" }
  | { kind: "openclaw-plugin" };

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
  /** What `@vercel/detect-agent` calls it when we are running inside it. */
  detectedAs: readonly string[];
}

export const CODING_AGENTS: readonly CodingAgent[] = [
  claudeCode,
  codex,
  cursor,
  opencode,
  cline,
  vscode,
  geminiCli,
  claudeDesktop,
  hermes,
  openclaw,
];

export const CODING_AGENT_IDS: readonly CodingAgentId[] = CODING_AGENTS.map((agent) => agent.id);

export const codingAgent = (id: CodingAgentId): CodingAgent =>
  CODING_AGENTS.find((agent) => agent.id === id)!;

/** The line the help prints under Usage, the way Docker MCP prints its clients. */
export const supportedAgentsLine = (): string => `Supported agents: ${CODING_AGENT_IDS.join(" ")}`;

/** Accepts an id or one of its aliases, in any case, with spaces around it. */
export const normalizeAgentId = (value: string): CodingAgentId | undefined => {
  const normalized = value.trim().toLowerCase();
  return CODING_AGENTS.find((agent) => agent.id === normalized || agent.aliases.includes(normalized))?.id;
};

/**
 * The agent `@vercel/detect-agent` says we are running inside, when we know it.
 * The package answers with its own short names, or with whatever `AI_AGENT`
 * holds; its README asks tools to set `<name>` or `<name>@<version>`, and
 * Claude Code 2.1 sets `claude-code_<version>_agent` (measured 2026-09-10 on
 * the owner's Mac mini), so the leading word is what is matched.
 */
export const agentDetectedAs = (name: string): CodingAgentId | undefined => {
  const normalized = name.trim().toLowerCase();
  const leading = normalized.split(/[@_/:\s]/u)[0] ?? "";
  return CODING_AGENTS.find((agent) => agent.detectedAs.includes(normalized) || agent.id === leading || agent.detectedAs.includes(leading))?.id;
};
