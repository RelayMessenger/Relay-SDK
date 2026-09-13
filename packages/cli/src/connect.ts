import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createAgentWithPicture, incompletePictureMessage } from "./agent-create.js";
import { validateFirstName, validateHandle, type AgentDependencies } from "./agents.js";
import { savedAgentShareURL } from "./agent-session.js";
import {
  CODING_AGENTS,
  CODING_AGENT_IDS,
  codingAgent,
  platformPath,
  claudeConfigDir,
  hermesHome,
  normalizeAgentId,
  supportedAgentsLine,
  type AgentPaths,
  type CodingAgentId,
} from "./coding-agents.js";
import { claudeChannelDir, sniffRuntimes, type RuntimeFound, type RuntimeId, type RuntimeSniffContext } from "./runtime-sniff.js";
import { readChannelEnv, writeChannelEnv, writeEnvFile } from "./claude-channel.js";
import { readFolderLink, writeFolderLink } from "./folder-link.js";
import { writeCodexProjectMcpServer } from "./coding-agents/codex-project-config.js";
import { configPath, defaultCreationApiURL, isStagingBuild, packageVersion, validateApiURL, validateProfileName, validateToken, type RelayConsoleSession } from "./config.js";
import { HeadlessPrompt, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { CliError, type CliErrorCode } from "./error-codes.js";
import { renderTerminalQR, terminalQRRowsLeft, type TerminalQROptions } from "./qr-terminal.js";
import { dim, handle as markHandle, link } from "./ui-colour.js";
import { safeMetadata } from "./output.js";
import { spawnCommand } from "./spawn-command.js";
import { runTerminalWatch, type TerminalObserver } from "./terminal-watch.js";
import { createConsoleAgent } from "./console-auth.js";

/** The plugin, and the marketplace it comes from, exactly as Claude Code names
 * them (.claude-plugin/marketplace.json: marketplace "relay-messenger", plugin "relay"). */
export const CLAUDE_MARKETPLACE_REPO = "RelayMessenger/Relay-SDK";
export const CLAUDE_PLUGIN_ID = "relay@relay-messenger";
/** A `-staging` build installs the plugin from `staging` and a release from
 * `main`, the same rule the Relay skill installer already follows. */
export const claudeMarketplaceSource = (version: string = packageVersion()): string =>
  `${CLAUDE_MARKETPLACE_REPO}@${isStagingBuild(version) ? "staging" : "main"}`;
/** Pairing waits this long for a first message before it names --allow instead. */
export const PAIR_TIMEOUT_MS = 180_000;
export const REPLY_TIMEOUT_MS = 300_000;

/** The MCP server the seven MCP agents run (packages/mcp, bin `relay-mcp`). A
 * staging build takes the `staging` dist-tag, the way it takes the staging API. */
export const MCP_PACKAGE = "@relaymessenger/mcp";
export const mcpPackageSpec = (version: string = packageVersion()): string =>
  isStagingBuild(version) ? `${MCP_PACKAGE}@staging` : MCP_PACKAGE;
/** The name every agent lists the server under. */
export const MCP_SERVER_NAME = "relay";
/** Our plugins for the two gateways, as Relay-Docs integrations/hermes.mdx and openclaw.mdx install them. */
export const HERMES_PLUGIN_SOURCE = "RelayMessenger/Relay-Hermes";
export const openclawPluginSpec = (version: string = packageVersion()): string =>
  `@relaymessenger/openclaw-plugin${isStagingBuild(version) ? "@staging" : ""}`;

/** Vercel's `skills` sentence for a pipe with no target and no -y (src/add.ts:408-418), with our nouns. */
export const NO_TTY_SENTENCE = "Interactive prompt required but stdin is not a TTY. Nothing was connected.";
export const NO_TTY_NEXT_STEP = "Name an agent and -y to run non-interactively.";

export interface ConnectOptions {
  new?: boolean;
  handle?: string;
  name?: string;
  about?: string;
  image?: string;
  /** A PNG or JPEG on this computer; `--image` also takes an https:// address. */
  avatar?: string;
  token?: string;
  allow?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** Commander delivers `--no-start` and `--no-skill` as false. */
  start?: boolean;
  skill?: boolean;
  json?: boolean;
  apiUrl?: string;
  /** The caller said never to ask (`--non-interactive`), so the plan is stated, not put as a question. */
  nonInteractive?: boolean;
}

export interface ConnectCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ConnectDependencies {
  agents: AgentDependencies;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  platform?: NodeJS.Platform;
  profile?: string;
  stdout(value: string): void;
  stderr(value: string): void;
  /** Absent means there is no terminal, so nothing may be asked. */
  prompts?: InteractivePrompts;
  /** The runtime this command is running inside, when one announced itself. */
  drivingAgent?: RuntimeId;
  sniff?: (context: RuntimeSniffContext) => Promise<RuntimeFound[]>;
  /** Runs one of the agent's own commands and waits for it. */
  runCommand?: (file: string, args: readonly string[]) => Promise<ConnectCommandResult>;
  /** Hands this terminal to the agent. */
  startCommand?: (file: string, args: readonly string[]) => Promise<number>;
  observer?: (token: string, apiURL: string) => TerminalObserver | undefined;
  /**
   * Keeps answering this agent's Relay messages with the runtime's own
   * headless command, until the person stops it. Codex reaches it over its
   * `app-server` (`kind: "codex"`, coding-agents/codex.ts); Cursor, Gemini CLI
   * and OpenCode reach it over the Agent Client Protocol (`kind: "acp"`,
   * coding-agents/{cursor,gemini-cli,opencode}.ts).
   */
  bridge?: (input: {
    kind: "codex" | "acp";
    token: string;
    apiURL: string;
    /** The agent that answers, so its threads or sessions are kept apart from another's. */
    handle: string;
    command: string;
    /** For an ACP agent, the words that put it in ACP mode, e.g. ["acp"]. */
    acpArgs?: readonly string[];
    /** The Relay MCP server handed to the agent's session, so its tools travel with it. */
    mcpServer: { command: string; args: string[]; env: Record<string, string> };
    label: string;
    cwd: string;
    say(line: string): void;
  }) => Promise<void>;
  renderQR?: (url: string, options?: TerminalQROptions) => string;
  pairTimeoutMs?: number;
  version?: string;
  fetch?: typeof globalThis.fetch;
  offerSkill?: () => Promise<void>;
  /** Authenticated Console session used when a new organization Agent is created. */
  consoleLogin?: () => Promise<RelayConsoleSession>;
  /** Console API request boundary for organization-owned Agent creation. */
  consoleRequest?: <T>(path: string, init?: RequestInit) => Promise<T>;
}

/**
 * A failure a person can act on: the sentence, and the next thing to run. The
 * next thing sits inside the sentence, because the envelope's `next_step` is
 * one fixed sentence per code (error-codes.ts).
 */
export class ConnectFailure extends CliError {
  constructor(message: string, readonly nextStep: string, code: CliErrorCode = "refused") {
    super(`${message} Run  ${nextStep}  next.`, code);
  }
}

export interface ConnectAgent {
  profile: string;
  handle: string;
  displayName: string;
  apiURL: string;
  shareURL: string;
  token: string;
  created: boolean;
}

/**
 * The optional step after the runtime question, in Hermes' shape (`hermes
 * setup`: "Step 2: Customize Your Bot (Optional)", "Add an MCP server now?"
 * defaulting to No with "Add later with `hermes mcp add`"). Enter skips every
 * one of these (owner ruling, 2026-09-12).
 */
export const CUSTOMIZE_QUESTION = "Customize the agent? (name, handle, about, avatar)";
export const CUSTOMIZE_HINT = "Enter skips. Relay picks a name and handle.";
export const NAME_QUESTION = "Name (optional)";
export const HANDLE_QUESTION = "Handle (optional)";
export const ABOUT_QUESTION = "About (optional)";
export const AVATAR_QUESTION = "Avatar (optional)";
export const NAME_PLACEHOLDER = "Relay picks one";
export const ABOUT_PLACEHOLDER = "One sentence about what it does";
export const AVATAR_PLACEHOLDER = "Path to a PNG or JPEG";
export const NOT_AN_IMAGE = "Not an image file. Enter skips.";
const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/**
 * The handle Relay's rule allows for a name (agents.ts, validateHandle): the
 * words lowercased and joined with underscores, a letter first, at most 32
 * before `.dev`. Undefined when nothing of the name survives the rule.
 */
export const handleFromName = (name: string): string | undefined => {
  const body = name.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^[^a-z]+/u, "").replace(/_+$/u, "").slice(0, 32).replace(/_+$/u, "");
  return body.length >= 3 ? `${body}.dev` : undefined;
};

/** The avatar's path when it is a PNG or JPEG that exists; undefined otherwise. */
export const avatarFile = (input: string, context: { cwd: string; home: string }): string | undefined => {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const path = resolve(context.cwd, trimmed.startsWith("~/") ? join(context.home, trimmed.slice(2)) : trimmed);
  if (!AVATAR_EXTENSIONS.has(extname(path).toLowerCase()) || !existsSync(path)) return undefined;
  try { if (!statSync(path).isFile()) return undefined; } catch { return undefined; }
  return path;
};

/** The line a re-run in a linked folder says, and the flag that makes another agent. */
export const linkedLine = (handle: string): string => `Linked to @${handle}; run  connect --new  for another, or  --profile <handle>  to link a saved one`;
export const SAY_HI = "Say hi from your phone";

/** What one runtime's part of the plan touches. */
export interface AgentPlan {
  agent: CodingAgentId;
  steps: string[];
  /** The files this command writes for that agent, in full. */
  files: string[];
  /** The agent's own commands this command runs, as one line each. */
  commands: string[];
}

export interface ConnectPlan {
  headline: string;
  steps: string[];
  agents: AgentPlan[];
}

export interface PlanContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  version: string;
  /** The folder connect runs in: the project scope of an agent that has one. */
  cwd: string;
  /** The saved profile the MCP server reads the token from. */
  profile: string;
  handle: string;
  /** What the person allowed with --allow, when anything. */
  allow: readonly string[];
  /** The agent's token and API address, once an agent exists: OpenClaw's own
   * `channels add` takes them as flags. Absent before an agent exists. */
  token?: string;
  apiURL?: string;
  start: boolean;
  /** The agents whose file already holds a token for someone else. */
  replacing?: Partial<Record<CodingAgentId, string>>;
  /** Present when the plan creates a new agent: what was chosen for it, when anything was. */
  create?: AgentIdentity;
  /** How a command or a path is marked inside a step. Absent means unmarked, so
   * every caller that prints the steps as data gets them byte for byte. */
  mark?: (value: string) => string;
}

const paths = (context: { env: NodeJS.ProcessEnv; home: string; platform: NodeJS.Platform; cwd: string }): AgentPaths =>
  ({ env: context.env, home: context.home, platform: context.platform, cwd: context.cwd });

/** The MCP server's own process flags and environment: the profile by name,
 * and the config file only when it is not the default one, so the server reads
 * the same file this command saved the token to (packages/mcp/src/auth.ts). */
export const mcpServerSpec = (context: PlanContext): { command: string; args: string[]; env: Record<string, string> } => {
  const path = platformPath(context.platform);
  const standard = path.join(context.home, ".config", "relay", "config.json");
  const saved = context.env.RELAY_CONFIG_PATH ?? path.resolve(context.env.RELAY_CONFIG_DIR ?? context.env.XDG_CONFIG_HOME ?? path.join(context.home, ".config"), "relay", "config.json");
  return {
    command: "npx",
    args: ["-y", mcpPackageSpec(context.version), "--profile", context.profile],
    env: saved === standard ? {} : { RELAY_CONFIG_PATH: saved },
  };
};

/** One entry, in the shape each agent's own documentation gives it. */
export const mcpEntry = (shape: "mcpServers" | "vscode" | "opencode", spec: ReturnType<typeof mcpServerSpec>): Record<string, unknown> => {
  const env = Object.keys(spec.env).length ? spec.env : undefined;
  if (shape === "opencode") {
    return { type: "local", command: [spec.command, ...spec.args], ...(env ? { environment: env } : {}), enabled: true };
  }
  return { ...(shape === "vscode" ? { type: "stdio" } : {}), command: spec.command, args: spec.args, ...(env ? { env } : {}) };
};

const mcpRootKey = (shape: "mcpServers" | "vscode" | "opencode"): string =>
  shape === "vscode" ? "servers" : shape === "opencode" ? "mcp" : "mcpServers";

const hermesEnvPath = (context: PlanContext): string => platformPath(context.platform).join(hermesHome(context.env, context.home, context.platform), ".env");
export const hermesStateDir = (context: PlanContext): string => {
  const path = platformPath(context.platform).join(hermesHome(context.env, context.home, context.platform), "relay");
  // Independently released plugins read literal .env values, not escapes.
  return context.platform === "win32" ? path.replace(/\\/gu, "/") : path;
};
/** A command line a person may read: the value after `--token` is never shown. */
export const shownCommandLine = (words: readonly string[]): string =>
  words.map((word, index) => (index > 0 && words[index - 1] === "--token" ? "<token>" : word)).join(" ");

/** The agent's own command lines, exactly as this command runs them. */
export const agentCommands = (agent: CodingAgentId, context: PlanContext): string[][] => {
  switch (agent) {
    case "claude-code":
      return [
        ["claude", "plugin", "marketplace", "add", claudeMarketplaceSource(context.version)],
        ["claude", "plugin", "install", CLAUDE_PLUGIN_ID, "--yes"],
        ["claude", "plugin", "enable", CLAUDE_PLUGIN_ID],
      ];
    case "hermes":
      return [["hermes", "plugins", "install", HERMES_PLUGIN_SOURCE, "--enable"]];
    case "openclaw":
      // OpenClaw stops on any npm source that is not ClawHub-reviewed unless
      // told `--force` ("Confirm non-ClawHub sources"), and refuses to enable a
      // plugin that declares capabilities unless told `--accept-capabilities`
      // (both from `openclaw plugins install --help`, measured on 2026.8.1 and
      // 2026.9.2 in the lane sandbox, 2026-09-10). The person confirmed this
      // plan, which names the install, so both confirmations pass through.
      // The plugin ships OpenClaw's own setup contract, so `openclaw channels add
      // relay --token --base-url` configures the channel through OpenClaw's own
      // command and its own channel store; Relay writes no OpenClaw file
      // (Relay-SDK feat/openclaw-setup-contract-20260912, 5b56722).
      return [
        ["openclaw", "plugins", "install", openclawPluginSpec(context.version), "--force", "--accept-capabilities"],
        ["openclaw", "channels", "add", "relay", "--token", context.token ?? "<token>", "--base-url", context.apiURL ?? "<api url>"],
      ];
    default:
      return [];
  }
};

/** The files this command writes for the agent, in full. */
export const agentFiles = (agent: CodingAgentId, context: PlanContext): string[] => {
  const method = codingAgent(agent).connect;
  switch (method.kind) {
    case "claude-plugin": return [platformPath(context.platform).join(context.env.RELAY_CHANNEL_DIR?.trim() || platformPath(context.platform).join(claudeConfigDir(context.env, context.home, context.platform), "channels", "relay"), ".env")];
    case "mcp-command": return [method.file(paths(context))];
    case "codex-project": return [method.file(paths(context))];
    case "mcp-file": return [method.file(paths(context))];
    // The ACP bridge writes no file: the Relay MCP server travels through the
    // agent's session instead (acp-bridge.ts).
    case "acp-bridge": return [];
    case "hermes-plugin": return [hermesEnvPath(context)];
    // OpenClaw's own command keeps the token; Relay writes nothing.
    case "openclaw-plugin": return [];
  }
};

/**
 * Every file this command writes and every command it runs for one agent, as
 * the lines the plan screen shows.
 */
export const agentPlan = (agent: CodingAgentId, context: PlanContext): AgentPlan => {
  const commands = agentCommands(agent, context).map(shownCommandLine);
  const files = agentFiles(agent, context);
  const replacing = context.replacing?.[agent];
  // The steps show marked copies; `files` and `commands` go back to the caller
  // plain, because a JSON answer carries them as data.
  const mark = context.mark ?? ((value: string) => value);
  const shown = { commands: commands.map(mark), files: files.map(mark) };
  const write = (path: string, names: string): string =>
    `${replacing ? "replace the token already in" : "write"}  ${path}  (${names})`;
  const label = codingAgent(agent).label;
  const method = codingAgent(agent).connect;
  // At most three lines: what is installed, what is written, what starts
  // (_artifacts/cli-connect-design-20260912.md, item 5).
  let steps: string[];
  switch (method.kind) {
    case "claude-plugin":
      steps = [
        // Both commands it runs, on the one install line (the tarball consumer
        // reads the marketplace source here, packages/cli/scripts/agent-tarball-consumer.mjs:47).
        `install  the Relay plugin for ${label}  (${shown.commands[0]}; ${shown.commands[1]})`,
        write(shown.files[0]!, "token, API address, allowed senders"),
        ...(context.start ? [`start ${label} with Relay when you are ready`] : []),
      ];
      break;
    case "mcp-command":
      steps = [`run  ${shown.commands[0]}  (adds the Relay MCP server to ${shown.files[0]})`];
      break;
    case "codex-project":
      steps = [
        `write  ./.codex/config.toml  (Relay's MCP server for this folder; Codex loads it when the folder is trusted)`,
        ...(context.start && codingAgent(agent).start?.kind === "bridge"
          ? [`keep running here, and answer your Relay messages with ${label} from this folder`]
          : []),
      ];
      break;
    case "mcp-file":
      steps = [`add  ${mcpRootKey(method.shape)}.${MCP_SERVER_NAME}  to  ${shown.files[0]}  (every other entry kept)`];
      break;
    case "acp-bridge":
      // Relay drives the agent over its own ACP server and hands Relay's MCP
      // tools into the session; no mcp.json is written.
      steps = [`keep running here, and answer your Relay messages with ${label} from this folder  (Relay's tools travel through the session; no mcp.json is written)`];
      break;
    case "hermes-plugin":
      steps = [
        `install  the Relay plugin for ${label}  (${shown.commands[0]})`,
        write(shown.files[0]!, `token, API address, state folder${context.allow.length ? ", allowed contacts" : ""}; Hermes has one Relay agent per install`),
        ...(context.start ? ["start the Hermes gateway when you are ready:  hermes gateway run"] : []),
      ];
      break;
    case "openclaw-plugin":
      steps = [
        `run  ${shown.commands[0]}`,
        `run  ${mark("openclaw channels add relay")}  (the token goes to OpenClaw's own channel store)`,
        ...(context.start ? ["restart the OpenClaw gateway when you are ready"] : []),
      ];
      break;
  }
  return { agent, steps, files, commands };
};

/** What a person chose for a new agent; every field is optional. */
export interface AgentIdentity {
  handle?: string;
  name?: string;
  about?: string;
  /** A resolved path to a PNG or JPEG on this computer. */
  avatar?: string;
}

/** The plan's first line when an agent will be created: unchanged when nothing
 * was chosen; otherwise the handle, the name, and the rest as dim words. */
export const createLine = (create: AgentIdentity | undefined, mark: (value: string) => string = (value) => value): string => {
  const { handle, name, about, avatar } = create ?? {};
  if (!name && !about && !avatar) return `create a new agent  (${handle ? `@${handle}` : "Relay picks the name"})`;
  return [
    handle ? `create @${handle}` : "create a new agent",
    ...(name ? [`"${name}"`] : []),
    ...(about ? [mark(`about: ${about}`)] : []),
    ...(avatar ? [mark(`avatar: ${basename(avatar)}`)] : []),
  ].join("  ");
};

/**
 * Every file this command writes and every command it runs, for every chosen
 * agent, on one screen before anything changes.
 */
export const runtimeConnectPlan = (input: PlanContext & { agents: readonly CodingAgentId[]; ask?: boolean }): ConnectPlan => {
  const agents = input.agents.map((agent) => agentPlan(agent, input));
  // A new agent is the first thing the plan makes, so it is the first line:
  // nothing is created until the plan is taken (owner, 2026-09-12, after a No
  // at Continue left a stray agent on staging).
  const steps = [...(input.create ? [createLine(input.create, input.mark)] : []), ...agents.flatMap((plan) => plan.steps)];
  // With `--non-interactive` no one can answer, so the plan is a statement:
  // clig.dev, Interactivity: "If --no-input is passed, don't prompt or do
  // anything interactive" (ledger row P27, captures/relay/ni2.out).
  const count = `Relay will do ${steps.length} ${steps.length === 1 ? "thing" : "things"}.`;
  return { headline: input.ask === false ? count : "Continue? (Y/n)", steps, agents };
};

const senderOf = (event: RelayWebhookEvent): { handle: string; text: string } | undefined => {
  const row = event as unknown as Record<string, unknown>;
  if (row.event_type !== "message.received") return undefined;
  const data = (row.data ?? {}) as Record<string, unknown>;
  const sender = (data.sender_handle ?? {}) as Record<string, unknown>;
  if (typeof sender.handle !== "string" || !sender.handle) return undefined;
  const parts = Array.isArray(data.parts) ? data.parts : [];
  const text = parts
    .map((part) => part as Record<string, unknown>)
    .filter((part) => part.type === "text" && typeof part.value === "string")
    .map((part) => part.value as string)
    .join(" ");
  return { handle: sender.handle, text };
};

/**
 * Watches only. This connection never answers Relay and never takes an event,
 * so the agent being connected still receives every message.
 */
export const waitForNewSender = async (
  observer: TerminalObserver,
  allowed: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ handle: string; text: string } | undefined> => {
  const known = new Set(allowed);
  const control = new AbortController();
  const forward = (): void => control.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(forward, options.timeoutMs);
  let found: { handle: string; text: string } | undefined;
  try {
    await observer.run({
      signal: control.signal,
      onStatus: () => undefined,
      onEvent: (event) => {
        if (found) return;
        const sender = senderOf(event);
        if (!sender || known.has(sender.handle)) return;
        found = sender;
        control.abort();
      },
    });
  } catch {
    // A dropped watch connection is not a failed connect; pairing simply ends.
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
  }
  return found;
};

const defaultRunCommand = async (file: string, args: readonly string[]): Promise<ConnectCommandResult> =>
  new Promise((resolve) => {
    const child = spawnCommand(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const defaultStartCommand = async (file: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve) => {
    const child = spawnCommand(file, args, { stdio: "inherit" });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });

interface Screen {
  say(line: string): void;
  step(line: string): void;
  /** The plan: its lines inside the gutter; the headline only where no question follows. */
  plan(headline: string, steps: readonly string[]): void;
  /** Work that takes a while: a spinner while it runs, its result when it stops. */
  work<T>(pending: string, run: () => Promise<T>, done: (value: T) => string): Promise<T>;
  /** The last line of an interactive run, on Clack's closing bar. */
  outro(line: string): void;
  /** A path or a command inside a sentence. */
  dim(value: string): string;
  /** A handle inside a sentence, always written with its @. */
  handle(value: string): string;
  /** An address a person can open. */
  link(value: string): string;
  json: boolean;
}

/** Reads a strict-JSON config file; absent is an empty object, broken is a refusal. */
const readJsonConfig = async (path: string, what: string): Promise<Record<string, unknown>> => {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try { parsed = text.trim() ? JSON.parse(text) : {}; }
  catch {
    throw new ConnectFailure(`${path} is not plain JSON, so Relay did not change it. Fix the file, or add the ${what} entry yourself, then run this command again.`, "npx relaymessenger connect");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectFailure(`${path} does not hold a JSON object, so Relay did not change it.`, "npx relaymessenger connect");
  }
  return parsed as Record<string, unknown>;
};

/** Writes the whole object back, same folder temp then rename, every other key kept. */
const writeJsonConfig = async (path: string, value: Record<string, unknown>): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.relay-connect-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
};

const objectAt = (root: Record<string, unknown>, key: string): Record<string, unknown> => {
  const existing = root[key];
  if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
    throw new ConnectFailure(`The "${key}" entry in that file is not an object, so Relay did not change it.`, "npx relaymessenger connect");
  }
  const value = (existing ?? {}) as Record<string, unknown>;
  root[key] = value;
  return value;
};

/** Adds `<rootKey>.relay` to an agent's MCP config file, every other entry kept. */
export const writeMcpFileEntry = async (path: string, shape: "mcpServers" | "vscode" | "opencode", spec: ReturnType<typeof mcpServerSpec>): Promise<void> => {
  const root = await readJsonConfig(path, MCP_SERVER_NAME);
  if (shape === "opencode" && root.$schema === undefined && !Object.keys(root).length) root.$schema = "https://opencode.ai/config.json";
  objectAt(root, mcpRootKey(shape))[MCP_SERVER_NAME] = mcpEntry(shape, spec);
  await writeJsonConfig(path, root);
};

const runAgentCommands = async (
  agent: CodingAgentId,
  runtime: RuntimeFound | undefined,
  context: PlanContext,
  runCommand: (file: string, args: readonly string[]) => Promise<ConnectCommandResult>,
): Promise<string[]> => {
  const ran: string[] = [];
  for (const [name, ...args] of agentCommands(agent, context)) {
    const file = runtime?.executable ?? name!;
    const outcome = await runCommand(file, args);
    const line = shownCommandLine([name!, ...args]);
    if (outcome.code !== 0) {
      // The agent's own words first, then what is true about Relay's side.
      const said = `${outcome.stderr}\n${outcome.stdout}`.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
      throw new ConnectFailure(
        `${line} did not finish.${said ? ` It said: ${said}` : ""} Nothing else was changed; your agent and its token are saved. Run the same command again.`,
        `npx relaymessenger connect ${agent} --yes`,
      );
    }
    ran.push(line);
  }
  return ran;
};

export const runConnect = async (
  requested: string | undefined,
  options: ConnectOptions,
  deps: ConnectDependencies,
): Promise<void> => {
  // Every flag is checked before anything is asked or shown: a bad --handle
  // once got through the picker and a "Creating your agent" spinner before it
  // was refused (fresh Linux sandbox, 2026-09-12).
  if (options.handle !== undefined) validateHandle(options.handle);
  if (options.name !== undefined) validateFirstName(options.name);
  if (options.token !== undefined) validateToken(options.token);
  if (options.avatar !== undefined && options.image !== undefined) throw new CliError("Choose --avatar or --image, not both.", "usage");
  const avatarFlag = options.avatar === undefined ? undefined : avatarFile(options.avatar, { cwd: deps.cwd, home: deps.home });
  if (options.avatar !== undefined && !avatarFlag) throw new CliError(`Not an image file: ${options.avatar}. --avatar takes a PNG or JPEG on this computer.`, "usage");
  const ui = options.nonInteractive ? undefined : deps.prompts;
  const json = options.json === true;
  // Only a framed, interactive run marks values.
  const marked = Boolean(ui) && !json;
  const screen: Screen = {
    json,
    say: (line) => { if (json) return; if (ui) ui.message(line); else deps.stdout(`${line}\n`); },
    step: (line) => { if (json) return; if (ui) ui.step(line); else deps.stdout(`${line}\n`); },
    plan: (headline, steps) => {
      if (json) return;
      if (ui) ui.message(steps.join("\n"));
      else deps.stdout(`${[headline, ...steps].join("\n")}\n`);
    },
    work: async (pending, run, done) => {
      if (json || !ui) { const value = await run(); screen.step(done(value)); return value; }
      const active = ui.spinner();
      active.start(pending);
      try {
        const value = await run();
        active.stop(done(value));
        return value;
      } catch (error) {
        // The failure says what went wrong; the spinner only stops holding the line.
        active.stop(pending);
        throw error;
      }
    },
    outro: (line) => { if (json) return; if (ui) ui.outro(line); else deps.stdout(`${line}\n`); },
    dim: (value) => marked ? dim(value) : value,
    handle: (value) => marked ? markHandle(value) : `@${value}`,
    link: (value) => marked ? link(value) : value,
  };
  const platform = deps.platform ?? process.platform;
  const runtimes = await (deps.sniff ?? sniffRuntimes)({ env: deps.env, home: deps.home, platform, cwd: deps.cwd });
  if (ui && !json) ui.intro("Relay");
  // The "Agent detected" line is said once per run by runCLI, for every command.
  const targets = await chooseAgents(requested, options, runtimes, deps);

  const version = deps.version ?? packageVersion();
  const allow = (options.allow ?? "").split(",").map((entry) => entry.trim().replace(/^@/u, "")).filter(Boolean);
  const context = (agent: ConnectAgent | PendingAgent | undefined, replacing?: PlanContext["replacing"]): PlanContext => ({
    env: deps.env, home: deps.home, platform, version, cwd: deps.cwd,
    profile: (agent && "profile" in agent ? agent.profile : undefined) ?? deps.profile ?? "<profile>",
    handle: agent?.handle ?? options.handle ?? "<handle>",
    allow, start: options.start !== false,
    ...(agent && "token" in agent ? { token: agent.token, apiURL: agent.apiURL } : {}),
    ...(agent && "pending" in agent ? { apiURL: agent.apiURL, create: agent.identity } : {}),
    ...(replacing ? { replacing } : {}),
    ...(marked ? { mark: dim } : {}),
  });

  if (options.dryRun === true) {
    // A dry run reads nothing private, creates nothing and asks nothing, so the
    // whole plan is printable before an agent exists.
    const dry = runtimeConnectPlan({ ...context(undefined), agents: targets, ask: options.nonInteractive !== true });
    screen.plan(dry.headline, dry.steps);
    screen.say("Dry run: nothing was changed.");
    if (json) {
      deps.stdout(`${JSON.stringify({
        ok: true, dry_run: true,
        agents: dry.agents.map((plan) => ({ agent: plan.agent, files: plan.files, commands: plan.commands })),
        steps: dry.steps.map((line) => line.trim()),
      }, null, 2)}\n`);
    }
    return;
  }

  const linked = await readFolderLink(deps.cwd);
  // Which agent: one that exists, or one the plan will create. Nothing is
  // created here; every question comes before the plan, and the plan before
  // anything is made.
  const chosen = await resolveAgent({ ...options, ...(avatarFlag ? { avatar: avatarFlag } : {}) }, deps, screen, linked);
  const known = "pending" in chosen ? undefined : chosen;

  // A token already in a .env file belongs to whatever answers as that agent
  // today, so it is never replaced without being told to.
  const replacing: PlanContext["replacing"] = {};
  for (const target of targets) {
    const path = target === "claude-code" ? join(claudeChannelDir(deps.env, deps.home), ".env")
      : target === "hermes" ? hermesEnvPath(context(chosen)) : undefined;
    if (!path) continue;
    let existing: string | undefined;
    try { existing = readChannelEnv(await readFile(path, "utf8")).RELAY_AGENT_TOKEN; } catch { /* No file yet. */ }
    if (!existing || existing === known?.token) continue;
    const config = await deps.agents.read();
    const owner = Object.entries(config.profiles).find(([, profile]) => profile.agent_token === existing)?.[0];
    replacing[target] = owner ? `@${owner}` : "another agent";
    if (options.yes === true) continue;
    if (!ui || json) {
      throw new HeadlessPrompt(`${path} already holds a token for ${replacing[target]}.`, ["--yes  to replace it with the agent you are connecting"]);
    }
    const answer = await ui.select(`${codingAgent(target).label} already has a Relay token for ${replacing[target]}. Keep it, or replace it with ${known ? `@${known.handle}` : "the new agent"}?`, [
      { value: "keep", label: "Keep" },
      { value: "replace", label: "Replace" },
    ]);
    if (answer !== "replace") {
      screen.say(`Kept the token for ${replacing[target]}. Nothing was changed there. Your agent and its token are saved on this computer.`);
      return;
    }
  }

  const plan = runtimeConnectPlan({ ...context(chosen, replacing), agents: targets, ask: options.nonInteractive !== true });
  screen.plan(plan.headline, plan.steps);
  // One question, and Enter says yes (fly: "Would you like to sign in? (Y/n)").
  // The plan named what starts, so nothing below asks again.
  if (options.yes !== true) {
    if (!ui || json) throw new HeadlessPrompt("Relay cannot ask you to confirm this plan.", ["--yes  to run the plan above"]);
    if (!await ui.confirm("Continue?", { initialValue: true })) throw new InteractiveCancelled();
  }

  // The plan was taken: only now is an agent created and its token saved.
  let consoleSession: RelayConsoleSession | undefined;
  if (!known && deps.consoleLogin && deps.consoleRequest) {
    consoleSession = await deps.consoleLogin();
  }
  const agent = known ?? await createNewAgent(chosen as PendingAgent, options, deps, screen, consoleSession);
  // The folder points at its agent, like `vercel link`; the token stays in the
  // global profile store, and the last connected agent is the default elsewhere.
  const linkPath = await writeFolderLink(deps.cwd, { handle: agent.handle, apiUrl: agent.apiURL });
  // The config is written once per connect: a created or pasted agent saved
  // its profile and the default together, so only an agent that was already
  // saved needs a write here, and only when the default changes. A second
  // write on a file that already exists is what the private-file check
  // refuses on a Windows host running as another platform (CI, 2026-09-12).
  if ((await deps.agents.read()).defaultAgent !== agent.profile) {
    await deps.agents.update((config) => { config.defaultAgent = agent.profile; });
  }
  const secrets = [agent.token];

  const runCommand = deps.runCommand ?? defaultRunCommand;
  const done: Array<Record<string, unknown>> = [];
  const allowed = [...allow];
  const starts: Array<{ command: string; args: string[]; label: string }> = [];
  let qrShown = false;
  let bridge: {
    label: string;
    command: string;
    kind: "codex" | "acp";
    acpArgs?: readonly string[];
    mcpServer: ReturnType<typeof mcpServerSpec>;
  } | undefined;
  for (const target of targets) {
    const runtime = runtimes.find((entry) => entry.id === target);
    const planned = plan.agents.find((entry) => entry.agent === target)!;
    const definition = codingAgent(target);
    const method = definition.connect;
    const ctx = context(agent, replacing);
    const result: Record<string, unknown> = { agent: target, files: planned.files, commands: planned.commands };
    if (method.kind === "claude-plugin") {
      const channelDir = claudeChannelDir(deps.env, deps.home);
      const envPath = join(channelDir, ".env");
      await screen.work("Installing the plugin", () => runAgentCommands(target, runtime, ctx, runCommand), () => "Plugin installed");
      await writeChannelEnv(channelDir, { token: agent.token, baseURL: agent.apiURL, allowedSenders: allowed }, platform);
      screen.step(`wrote  ${screen.dim(envPath)}`);
      if (!allowed.length) {
        qrShown = true;
        const paired = await pairFirstSender(agent, deps, screen);
        if (paired) {
          allowed.push(paired);
          await writeChannelEnv(channelDir, { token: agent.token, baseURL: agent.apiURL, allowedSenders: allowed }, platform);
          screen.step(`Allowed: ${screen.handle(paired)}`);
        }
      }
      Object.assign(result, { env_path: envPath, plugin: CLAUDE_PLUGIN_ID, marketplace: claudeMarketplaceSource(version), allowed_senders: allowed });
    } else if (method.kind === "mcp-command") {
      await screen.work(
        `Adding the Relay MCP server to ${codingAgent(target).label}`,
        () => runAgentCommands(target, runtime, ctx, runCommand),
        () => `Relay MCP server added to ${codingAgent(target).label}  ${screen.dim(planned.files[0] ?? "")}`,
      );
    } else if (method.kind === "codex-project") {
      const spec = mcpServerSpec(ctx);
      const file = await writeCodexProjectMcpServer(deps.cwd, { name: MCP_SERVER_NAME, command: spec.command, args: spec.args, env: spec.env });
      screen.step(`wrote  ${screen.dim(file)}`);
    } else if (method.kind === "mcp-file") {
      await writeMcpFileEntry(planned.files[0]!, method.shape, mcpServerSpec(ctx));
      screen.step(`wrote  ${screen.dim(planned.files[0] ?? "")}`);
    } else if (method.kind === "acp-bridge") {
      // Nothing is written: the Relay MCP server is handed to the agent's ACP
      // session, and this process drives the agent's turns (acp-bridge.ts).
      screen.step(`Relay drives ${codingAgent(target).label} over ACP; no mcp.json is written`);
    } else if (method.kind === "hermes-plugin") {
      await screen.work("Installing the plugin", () => runAgentCommands(target, runtime, ctx, runCommand), () => "Plugin installed");
      await writeEnvFile(hermesEnvPath(ctx), {
        RELAY_AGENT_TOKEN: agent.token,
        RELAY_BASE_URL: agent.apiURL,
        RELAY_STATE_DIR: hermesStateDir(ctx),
        ...(allowed.length ? { RELAY_ALLOWED_CONTACTS: allowed.join(",") } : {}),
      }, "Hermes", platform);
      screen.step(`wrote  ${screen.dim(hermesEnvPath(ctx))}`);
      Object.assign(result, { env_path: hermesEnvPath(ctx), start_command: "hermes gateway run" });
    } else {
      // Both of OpenClaw's own commands: the plugin, then the channel with the token.
      await screen.work("Installing the plugin", () => runAgentCommands(target, runtime, ctx, runCommand), () => "Plugin installed, channel added");
      Object.assign(result, { channel: MCP_SERVER_NAME });
    }
    const start = definition.start;
    if (start?.kind === "bridge") {
      const command = runtime?.executable ?? start.command;
      result.bridge_command = command;
      // The plan's last line said this starts, and Continue took it.
      if (!json && options.start !== false && (options.yes === true || ui !== undefined)) {
        bridge = { label: definition.label, command, kind: "codex", mcpServer: mcpServerSpec(ctx) };
      }
    } else if (start?.kind === "acp-bridge") {
      const command = runtime?.executable ?? start.command;
      result.bridge_command = command;
      result.bridge_args = [...start.args];
      if (!json && options.start !== false && (options.yes === true || ui !== undefined)) {
        bridge = { label: definition.label, command, kind: "acp", acpArgs: start.args, mcpServer: mcpServerSpec(ctx) };
      }
    } else if (start?.kind === "command") {
      const command = runtime?.executable ?? start.command;
      const commandLine = [command, ...start.args].join(" ");
      result.start_command = commandLine;
      if (!json) {
        if (options.start !== false && ui !== undefined) starts.push({ command, args: start.args, label: definition.label });
        else screen.say(`Start it yourself when you are ready:  ${screen.dim(commandLine)}`);
      }
    } else if (start?.kind === "restart" && !json) {
      screen.say(start.instruction);
    }
    done.push(result);
  }

  if (json) {
    deps.stdout(`${JSON.stringify(safeMetadata({
      ok: true, profile: agent.profile, handle: agent.handle, api_url: agent.apiURL, token: "stored",
      link: { path: linkPath, handle: agent.handle, api_url: agent.apiURL },
      agents: done, proof: "skipped",
    }, secrets), null, 2)}\n`);
  }
  if (options.skill !== false && deps.offerSkill && !json) await deps.offerSkill();
  if (!json) {
    if (!qrShown) showAddQR(agent, deps, screen);
    if (bridge && deps.bridge) {
      screen.say(`${bridge.label} answers your Relay messages from ${deps.cwd}. Press Control-C to stop.`);
      await deps.bridge({
        kind: bridge.kind, token: agent.token, apiURL: agent.apiURL, handle: agent.handle,
        command: bridge.command, ...(bridge.acpArgs ? { acpArgs: bridge.acpArgs } : {}),
        mcpServer: bridge.mcpServer, label: bridge.label, cwd: deps.cwd,
        say: (line) => screen.say(safeMetadata(line, secrets)),
      });
      screen.say(`Stopped. ${bridge.label} no longer answers your Relay messages.`);
    } else if (!ui) {
      screen.say(`No reply yet. Run:  relay watch @${agent.handle}`);
    } else {
      // Subscribe before launching: an immediate reply must not be lost while
      // the foreground agent owns the terminal. Starting remains opt-in.
      const control = new AbortController();
      const proof = waitForFirstReply(agent, deps, control, starts.length === 0);
      if (starts.length) {
        try {
          for (const start of starts) {
            await (deps.startCommand ?? defaultStartCommand)(start.command, start.args);
          }
        } finally {
          control.abort();
        }
      }
      const said = (reply: string | undefined): string => reply === undefined
        ? `No reply yet. Run:  ${screen.dim(`relay watch @${agent.handle}`)}`
        : `Answered from your phone: ${reply}`;
      // A started agent owns the terminal, so a spinner would fight it for the line.
      if (starts.length) screen.say(said(await proof));
      else await screen.work("Waiting for a reply", () => proof, said);
    }
    if (ui) screen.outro("");
  }
};

/** Reuse watch's read-only loop and rendering, but stop at this agent's reply. */
const waitForFirstReply = async (agent: ConnectAgent, deps: ConnectDependencies, control: AbortController, bounded: boolean): Promise<string | undefined> => {
  const source = deps.observer?.(agent.token, agent.apiURL);
  const timer = bounded ? setTimeout(() => control.abort(), REPLY_TIMEOUT_MS) : undefined;
  let reply: string | undefined;
  const observer: TerminalObserver | undefined = source && {
    semantics: source.semantics,
    run: (input) => source.run({
      ...input,
      onEvent: (event) => {
        const row = event as unknown as { event_type?: string; data?: { sender_handle?: { handle?: string } | null } };
        if (row.event_type === "message.sent" && row.data?.sender_handle?.handle === agent.handle) input.onEvent(event);
      },
    }),
  };
  try {
    await runTerminalWatch({
      ...(observer ? { observer } : {}), runtimeOwnership: "external", signal: control.signal,
      secrets: [agent.token], onStatus: () => undefined,
      onLine: (line) => { reply = line.includes(" — ") ? line.slice(line.indexOf(" — ") + 3) : ""; control.abort(); },
    });
  } finally {
    clearTimeout(timer);
  }
  return reply;
};

/**
 * Which runtime to connect. A name on the command line decides; a terminal
 * asks with the detected ones pre-selected; a
 * pipe with nothing named exits 2 with the sentence and the next step. Detection
 * pre-selects and never chooses (Vercel's resolve.ts:73-86).
 */
const chooseAgents = async (
  requested: string | undefined,
  options: ConnectOptions,
  runtimes: readonly RuntimeFound[],
  deps: ConnectDependencies,
): Promise<CodingAgentId[]> => {
  const found = runtimes.filter((runtime) => runtime.found).map((runtime) => runtime.id);
  if (requested !== undefined) {
    const normalized = normalizeAgentId(requested);
    if (!normalized) {
      throw new ConnectFailure(`Unknown agent: ${requested.trim()}. ${supportedAgentsLine()}`, "npx relaymessenger connect --help", "usage");
    }
    return [normalized];
  }
  if (deps.drivingAgent) return [deps.drivingAgent];
  if (!deps.prompts || options.json) {
    if (options.json && options.dryRun && found.length === 0) throw new ConnectFailure("No runtime was found on this computer.", "npx relaymessenger connect <agent>", "no_runtime");
    throw new HeadlessPrompt(NO_TTY_SENTENCE, [], NO_TTY_NEXT_STEP);
  }
  // One question: the agents found on this computer first, in the order they
  // were found, the default the first of them; the rest after, dimmed, still
  // there to pick (_artifacts/cli-connect-design-20260912.md, item 1).
  const optionsList = [
    ...CODING_AGENTS.filter((agent) => found.includes(agent.id)).map((agent) => ({ value: agent.id, label: agent.label })),
    ...CODING_AGENTS.filter((agent) => !found.includes(agent.id)).map((agent) => ({ value: agent.id, label: agent.label, hint: "not found", dim: true })),
  ];
  const picked = await deps.prompts.select("Where does your agent run?", optionsList, optionsList[0]!.value);
  const chosen = normalizeAgentId(picked);
  if (!chosen) throw new InteractiveCancelled();
  return [chosen];
};

const saveExistingAgent = async (
  raw: string,
  apiURL: string,
  deps: ConnectDependencies,
): Promise<ConnectAgent> => {
  const token = validateToken(raw);
  let handle: string;
  let displayName: string;
  try {
    const cards = await deps.agents.client(token, apiURL).contactCard.retrieve();
    const own = cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active);
    if (own.length !== 1) throw new Error("This token must belong to exactly one active agent.");
    handle = own[0]!.handle;
    displayName = own[0]!.first_name;
  } catch {
    throw new ConnectFailure(
      "Relay would not accept that token, so nothing was changed.",
      "npx relaymessenger connect <agent> --token <token>",
    );
  }
  const profile = await deps.agents.update((config) => {
    const base = validateProfileName(deps.profile ?? handle);
    let name = base;
    for (let suffix = 2; config.profiles[name] && config.profiles[name]?.agent_token !== token; suffix++) {
      name = `${base.slice(0, 54)}-${suffix}`;
    }
    config.profiles[name] = { api_url: apiURL, agent_token: token };
    config.defaultAgent = name;
    return name;
  });
  return { profile, handle, displayName, apiURL, token, created: false, shareURL: savedAgentShareURL(apiURL, handle) };
};

/** A profile this computer holds, as the agent connect uses: profiles are keyed by handle. */
const savedAgent = async (profile: string, deps: ConnectDependencies, apiURL: string): Promise<ConnectAgent | undefined> => {
  const saved = (await deps.agents.read()).profiles[profile];
  if (!saved?.agent_token) return undefined;
  const url = saved.api_url ? validateApiURL(saved.api_url) : apiURL;
  return { profile, handle: profile, displayName: profile, apiURL: url, token: saved.agent_token, created: false, shareURL: savedAgentShareURL(url, profile) };
};

/** An agent the plan will create once it is taken. */
interface PendingAgent {
  pending: true;
  apiURL: string;
  handle?: string;
  identity: AgentIdentity;
}

/** The flags first; then, in a terminal, the optional step with one question per field the flags left open. */
const chooseIdentity = async (options: ConnectOptions, deps: ConnectDependencies): Promise<AgentIdentity> => {
  const identity: AgentIdentity = {
    ...(options.handle ? { handle: options.handle } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.about ? { about: options.about } : {}),
    ...(options.avatar ? { avatar: options.avatar } : {}),
  };
  const ui = deps.prompts;
  if (!ui || options.json || options.nonInteractive) return identity;
  const open = (["name", "handle", "about", "avatar"] as const).filter((field) => identity[field] === undefined);
  if (!open.length) return identity;
  if (!await ui.confirm(CUSTOMIZE_QUESTION, { initialValue: false, hint: CUSTOMIZE_HINT })) return identity;
  if (open.includes("name")) {
    const name = (await ui.text(NAME_QUESTION, "", {
      placeholder: NAME_PLACEHOLDER,
      validate: (value) => { try { if (value.trim()) validateFirstName(value); return undefined; } catch (error) { return (error as Error).message; } },
    })).trim();
    if (name) identity.name = name;
  }
  if (open.includes("handle")) {
    // The placeholder is the handle Relay's rule gives the name, and Enter takes it.
    const derived = identity.name ? handleFromName(identity.name) : undefined;
    const typed = (await ui.text(HANDLE_QUESTION, "", {
      placeholder: derived ?? NAME_PLACEHOLDER,
      validate: (value) => { try { if (value.trim()) validateHandle(value.trim()); return undefined; } catch (error) { return (error as Error).message; } },
    })).trim();
    if (typed) identity.handle = typed;
    else if (derived) identity.handle = derived;
  }
  if (open.includes("about")) {
    const about = (await ui.text(ABOUT_QUESTION, "", { placeholder: ABOUT_PLACEHOLDER })).trim();
    if (about) identity.about = about;
  }
  if (open.includes("avatar")) {
    const where = { cwd: deps.cwd, home: deps.home };
    const avatar = (await ui.text(AVATAR_QUESTION, "", {
      placeholder: AVATAR_PLACEHOLDER,
      validate: (value) => value.trim() && !avatarFile(value, where) ? NOT_AN_IMAGE : undefined,
    })).trim();
    const path = avatar ? avatarFile(avatar, where) : undefined;
    if (path) identity.avatar = path;
  }
  return identity;
};

/**
 * Which agent to connect: the one named by a token, a linked folder or an
 * answer, or a pending creation. Nothing is created here.
 */
const resolveAgent = async (
  options: ConnectOptions,
  deps: ConnectDependencies,
  screen: Screen,
  linked: Awaited<ReturnType<typeof readFolderLink>>,
): Promise<ConnectAgent | PendingAgent> => {
  const apiURL = validateApiURL(options.apiUrl ?? deps.env.RELAY_API_URL ?? defaultCreationApiURL(deps.version));
  if (options.token !== undefined) return saveExistingAgent(options.token, apiURL, deps);
  if (options.new !== true) {
    // A linked folder already said which agent (item 2): use it, and say so in one line.
    if (linked) {
      const agent = await savedAgent(linked.handle, deps, apiURL);
      if (agent) {
        screen.step(linkedLine(agent.handle));
        return agent;
      }
      screen.say(`This folder is linked to ${screen.handle(linked.handle)}, which this computer does not hold.`);
    }
    if (!deps.prompts || options.json) {
      throw new HeadlessPrompt("Relay cannot ask which agent to connect.", [
        "--new  to create one, with --handle and --name if you want to choose them",
        "--token <token>  to use an agent you already have",
      ]);
    }
    // The second question exists only when there is something to choose from
    // (item 3): the saved agents on this computer, after "New agent".
    const config = await deps.agents.read();
    const saved = Object.entries(config.profiles).filter(([, profile]) => profile.agent_token).map(([name]) => name);
    if (saved.length) {
      const answer = await deps.prompts.select("Which agent?", [
        { value: "new", label: "New agent" },
        ...saved.map((name) => ({ value: name, label: `@${name}` })),
      ], "new");
      if (answer !== "new") {
        const agent = await savedAgent(answer, deps, apiURL);
        if (agent) return agent;
      }
    }
  }
  const identity = await chooseIdentity(options, deps);
  return { pending: true, apiURL, ...(identity.handle ? { handle: identity.handle } : {}), identity };
};

/** Creates the agent the plan named and saves its token; runs only after Continue. */
const createNewAgent = async (
  pending: PendingAgent,
  options: ConnectOptions,
  deps: ConnectDependencies,
  screen: Screen,
  consoleSession?: RelayConsoleSession,
): Promise<ConnectAgent> => {
  const { apiURL, handle, identity } = pending;
  // The picture goes up through the same upload `contact-card update --image`
  // uses (agent-image-upload.ts), after the agent exists and before "Say hi".
  if (!consoleSession?.organization_id || !deps.consoleRequest) {
    const image = identity.avatar ?? options.image;
    const created = await screen.work("Creating your agent", () => createAgentWithPicture({
      apiURL,
      ...(deps.profile ? { profile: deps.profile } : {}),
      ...(handle ? { handle } : {}),
      ...(identity.name ? { firstName: identity.name } : {}),
      ...(identity.about === undefined ? {} : { about: identity.about }),
      ...(image ? { image } : {}),
      cwd: deps.cwd,
      home: deps.home,
      makeDefault: true,
    }, deps.agents, deps.fetch), (result) => `Created ${screen.handle(result.result.handle)}  token saved privately on this computer`);
    if (created.image && created.image.status !== "updated") {
      screen.say(screen.dim(`avatar not set: ${incompletePictureMessage(created.result.handle, created.result.profile, created.image, false)}`));
    }
    const saved = (await deps.agents.read()).profiles[created.result.profile];
    if (!saved?.agent_token) {
      throw new ConnectFailure(
        "The agent was created but its token was not saved on this computer, so Relay wrote no configuration.",
        "npx relaymessenger agents list",
      );
    }
    return {
      profile: created.result.profile,
      handle: created.result.handle,
      displayName: created.result.display_name,
      apiURL: created.result.api_url,
      shareURL: created.result.share_url,
      token: saved.agent_token,
      created: true,
    };
  }
  const displayName = identity.name ?? "My Agent";
  const created = await screen.work("Creating your agent", async () => {
    const result = await createConsoleAgent(
      { context: { env: deps.env, home: deps.home, cwd: deps.cwd }, apiURL, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
      {
        displayName,
        ...(handle ? { handle: handle.replace(/\.dev$/u, "") } : {}),
        ...(identity.about === undefined ? {} : { about: identity.about }),
        ...((identity.avatar ?? options.image) === undefined ? {} : { image: identity.avatar ?? options.image }),
        ...(deps.cwd ? { cwd: deps.cwd } : {}),
        ...(deps.home ? { home: deps.home } : {}),
      },
    );
    const profile = result.agent.handle;
    await deps.agents.update((config) => {
      config.profiles[profile] = {
        api_url: apiURL,
        agent_token: result.token,
      };
      config.defaultAgent = profile;
    });
    return {
      result: {
        profile,
        handle: result.agent.handle,
        display_name: result.agent.first_name,
        image_url: result.agent.image_url,
        api_url: apiURL,
        share_url: savedAgentShareURL(apiURL, result.agent.handle),
      },
      ...(result.image ? { image: result.image } : {}),
    };
  }, (result) => `Created ${screen.handle(result.result.handle)}  token saved privately on this computer`);
  if (created.image?.status === "incomplete") {
    screen.say(screen.dim(`avatar not set: ${incompletePictureMessage(created.result.handle, created.result.profile, created.image, false)}`));
  }
  const saved = (await deps.agents.read()).profiles[created.result.profile];
  if (!saved?.agent_token) {
    throw new ConnectFailure(
      "The agent was created but its token was not saved on this computer, so Relay wrote no configuration.",
      "npx relaymessenger agents list",
    );
  }
  return {
    profile: created.result.profile,
    handle: created.result.handle,
    displayName: created.result.display_name,
    apiURL: created.result.api_url,
    shareURL: created.result.share_url,
    token: saved.agent_token,
    created: true,
  };
};

/**
 * The step a person takes next on their phone: add the agent. The QR holds the
 * agent's public link, never the token, and Relay's New Chat screen scans it.
 * Every interactive connect ends here, so the person never types a handle.
 */
const showAddQR = (agent: ConnectAgent, deps: ConnectDependencies, screen: Screen): void => {
  const share = agent.shareURL || savedAgentShareURL(agent.apiURL, agent.handle);
  screen.step(SAY_HI);
  if (share) {
    // The step above the code, the link and the sentence below it, and the line
    // the shell takes back: the code gets what is left of the window.
    try { deps.stdout(`${(deps.renderQR ?? renderTerminalQR)(share, { rows: terminalQRRowsLeft(process.stdout.rows, 4) })}${screen.link(share)}\n`); }
    catch { deps.stdout(`${screen.link(share)}\n`); }
  }
};

const pairFirstSender = async (
  agent: ConnectAgent,
  deps: ConnectDependencies,
  screen: Screen,
): Promise<string | undefined> => {
  const ui = deps.prompts;
  if (!ui || screen.json) {
    throw new HeadlessPrompt("Relay cannot wait for a first message here.", [
      "--allow <handles>  the handles allowed to message this agent, separated by commas",
    ]);
  }
  showAddQR(agent, deps, screen);
  const observer = deps.observer?.(agent.token, agent.apiURL);
  if (!observer) {
    screen.say("Relay could not open its watch connection, so it did not wait for a first message.");
    return undefined;
  }
  const spinner = ui.spinner();
  spinner.start("Waiting for the first message…");
  const sender = await waitForNewSender(observer, [], { timeoutMs: deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS });
  spinner.stop(sender ? `@${sender.handle} wrote "${sender.text}"` : "No message yet.");
  if (!sender) {
    screen.say("No message arrived. Run  npx relaymessenger connect claude-code --allow <your handle>  to allow a sender without waiting.");
    return undefined;
  }
  return await ui.confirm(`Allow @${sender.handle} to message this agent?`) ? sender.handle : undefined;
};
