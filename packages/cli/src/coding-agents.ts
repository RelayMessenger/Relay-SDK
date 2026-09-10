import { join } from "node:path";

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

const appData = (paths: AgentPaths): string => paths.env.APPDATA?.trim() || join(paths.home, "AppData", "Roaming");
const configHome = (paths: AgentPaths): string => join(paths.home, ".config");
const appSupport = (paths: AgentPaths): string => join(paths.home, "Library", "Application Support");

/**
 * `CLAUDE_CONFIG_DIR` replaces the default folder rather than adding to it. The
 * Relay channel resolves the same way, so both sides always read one file
 * (packages/claude-code/src/config.ts, `defaultChannelDir`).
 */
export const claudeConfigDir = (env: NodeJS.ProcessEnv, home: string): string => {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(home, ".claude");
};
export const codexHome = (env: NodeJS.ProcessEnv, home: string): string => {
  const configured = env.CODEX_HOME?.trim();
  return configured ? configured : join(home, ".codex");
};
export const hermesHome = (env: NodeJS.ProcessEnv, home: string): string => {
  const configured = env.HERMES_HOME?.trim();
  return configured ? configured : join(home, ".hermes");
};
export const openclawHome = (home: string): string => join(home, ".openclaw");

/** Per-OS config files, quoted from Docker's registry (`paths:` per client). */
const byPlatform = (paths: AgentPaths, files: { darwin: string; win32: string; linux: string }): string =>
  paths.platform === "darwin" ? files.darwin : paths.platform === "win32" ? files.win32 : files.linux;

export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    aliases: ["claude", "claudecode"],
    command: "claude",
    installedIf: (paths) => [claudeConfigDir(paths.env, paths.home)],
    connect: { kind: "claude-plugin" },
    detectedAs: ["claude"],
  },
  {
    id: "codex",
    label: "Codex",
    aliases: [],
    command: "codex",
    installedIf: (paths) => [codexHome(paths.env, paths.home)],
    // `codex mcp add` writes ~/.codex/config.toml (its own --config help names the file).
    connect: { kind: "mcp-command", file: (paths) => join(codexHome(paths.env, paths.home), "config.toml") },
    detectedAs: ["codex"],
  },
  {
    id: "cursor",
    label: "Cursor",
    aliases: [],
    installedIf: (paths) => [join(paths.home, ".cursor")],
    // https://cursor.com/docs/context/mcp: "Create ~/.cursor/mcp.json in your home
    // directory for tools available everywhere"; entries live under `mcpServers`.
    connect: { kind: "mcp-file", file: (paths) => join(paths.home, ".cursor", "mcp.json"), shape: "mcpServers" },
    detectedAs: ["cursor", "cursor-cli"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    aliases: [],
    command: "opencode",
    installedIf: (paths) => [join(configHome(paths), "opencode")],
    // https://opencode.ai/docs/mcp-servers/: local servers are `mcp.<name>` with
    // `type: "local"`, a `command` array, `environment` and `enabled`; the global
    // file is ~/.config/opencode/opencode.json (Docker's registry, row `opencode`).
    connect: { kind: "mcp-file", file: (paths) => join(configHome(paths), "opencode", "opencode.json"), shape: "opencode" },
    detectedAs: ["opencode"],
  },
  {
    id: "cline",
    label: "Cline",
    aliases: [],
    command: "cline",
    installedIf: (paths) => [join(paths.home, ".cline")],
    // `cline mcp add --yes <name> -- <command>` writes the CLI's own
    // ~/.cline/data/settings/cline_mcp_settings.json (measured 2026-09-10 in the
    // lane sandbox, cline 3.0.61); its entry shape is Cline's, so Cline writes it.
    connect: { kind: "mcp-command", file: (paths) => join(paths.home, ".cline", "data", "settings", "cline_mcp_settings.json") },
    detectedAs: [],
  },
  {
    id: "vscode",
    label: "VS Code",
    aliases: ["vs-code", "code"],
    installedIf: (paths) => [
      join(configHome(paths), "Code"),
      join(appData(paths), "Code"),
      "/Applications/Visual Studio Code.app",
    ],
    // https://code.visualstudio.com/docs/copilot/reference/mcp-configuration: the
    // user file holds `servers.<name>` with `type: "stdio"`, `command`, `args`,
    // `env`. Its location is the User folder of the profile (Docker's registry,
    // row `vscode`: ~/.config/Code/User/mcp.json, ~/Library/Application
    // Support/Code/User/mcp.json, %APPDATA%\Code\User\mcp.json).
    connect: {
      kind: "mcp-file",
      file: (paths) => byPlatform(paths, {
        darwin: join(appSupport(paths), "Code", "User", "mcp.json"),
        win32: join(appData(paths), "Code", "User", "mcp.json"),
        linux: join(configHome(paths), "Code", "User", "mcp.json"),
      }),
      shape: "vscode",
    },
    detectedAs: [],
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    aliases: ["gemini"],
    command: "gemini",
    installedIf: (paths) => [join(paths.home, ".gemini")],
    // `gemini mcp add -s user` writes ~/.gemini/settings.json (Docker's registry, row `gemini`).
    connect: { kind: "mcp-command", file: (paths) => join(paths.home, ".gemini", "settings.json") },
    detectedAs: ["gemini"],
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    aliases: ["desktop"],
    installedIf: (paths) => ["/Applications/Claude.app", join(appData(paths), "Claude")],
    // https://modelcontextprotocol.io/docs/develop/connect-local-servers: the file
    // is ~/Library/Application Support/Claude/claude_desktop_config.json on macOS
    // and %APPDATA%\Claude\claude_desktop_config.json on Windows, entries under
    // `mcpServers`. Linux has no Claude Desktop; Docker's registry names
    // ~/.config/claude/claude_desktop_config.json there and so does Relay.
    connect: {
      kind: "mcp-file",
      file: (paths) => byPlatform(paths, {
        darwin: join(appSupport(paths), "Claude", "claude_desktop_config.json"),
        win32: join(appData(paths), "Claude", "claude_desktop_config.json"),
        linux: join(configHome(paths), "claude", "claude_desktop_config.json"),
      }),
      shape: "mcpServers",
    },
    detectedAs: [],
  },
  {
    id: "hermes",
    label: "Hermes",
    aliases: [],
    command: "hermes",
    installedIf: (paths) => [hermesHome(paths.env, paths.home)],
    connect: { kind: "hermes-plugin" },
    detectedAs: [],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    aliases: ["open-claw"],
    command: "openclaw",
    installedIf: (paths) => [openclawHome(paths.home), join(paths.home, ".clawdbot"), join(paths.home, ".moltbot")],
    connect: { kind: "openclaw-plugin" },
    detectedAs: [],
  },
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
