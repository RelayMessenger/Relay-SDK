import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createAgentWithPicture, incompletePictureMessage } from "./agent-create.js";
import type { AgentDependencies } from "./agents.js";
import { savedAgentShareURL } from "./agent-session.js";
import {
  CODING_AGENTS,
  CODING_AGENT_IDS,
  codingAgent,
  platformPath,
  claudeConfigDir,
  hermesHome,
  normalizeAgentId,
  openclawHome,
  supportedAgentsLine,
  type AgentPaths,
  type CodingAgentId,
} from "./coding-agents.js";
import { claudeChannelDir, sniffRuntimes, type RuntimeFound, type RuntimeId, type RuntimeSniffContext } from "./runtime-sniff.js";
import { readChannelEnv, writeChannelEnv, writeEnvFile } from "./claude-channel.js";
import { configPath, defaultCreationApiURL, isStagingBuild, packageVersion, validateApiURL, validateProfileName, validateToken } from "./config.js";
import { HeadlessPrompt, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { CliError, type CliErrorCode } from "./error-codes.js";
import { preparePrivateDestination, writePrivateDestination } from "./private-file.js";
import { renderTerminalQR } from "./qr-terminal.js";
import { safeMetadata } from "./output.js";
import { runTerminalWatch, type TerminalObserver } from "./terminal-watch.js";

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
export const NO_TTY_NEXT_STEP = "Name an agent (or --all) and -y to run non-interactively.";

export interface ConnectOptions {
  all?: boolean;
  new?: boolean;
  handle?: string;
  name?: string;
  about?: string;
  image?: string;
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
  /** The coding agent this command is running inside, when one announced itself. */
  drivingAgent?: RuntimeId;
  sniff?: (context: RuntimeSniffContext) => Promise<RuntimeFound[]>;
  /** Runs one of the agent's own commands and waits for it. */
  runCommand?: (file: string, args: readonly string[]) => Promise<ConnectCommandResult>;
  /** Hands this terminal to the agent. */
  startCommand?: (file: string, args: readonly string[]) => Promise<number>;
  observer?: (token: string, apiURL: string) => TerminalObserver | undefined;
  /**
   * Keeps answering this agent's Relay messages with the coding agent's own
   * headless command, until the person stops it. Only an agent whose `start` is
   * a bridge uses it (coding-agents/codex.ts).
   */
  bridge?: (input: {
    token: string;
    apiURL: string;
    command: string;
    cwd: string;
    say(line: string): void;
  }) => Promise<void>;
  renderQR?: (url: string) => string;
  pairTimeoutMs?: number;
  version?: string;
  fetch?: typeof globalThis.fetch;
  offerSkill?: () => Promise<void>;
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

/** What one coding agent's part of the plan touches. */
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

const numbered = (steps: readonly string[]): string[] =>
  steps.map((line, index) => `  ${index + 1}  ${line}`);

export interface PlanContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  version: string;
  /** The saved profile the MCP server reads the token from. */
  profile: string;
  handle: string;
  /** What the person allowed with --allow, when anything. */
  allow: readonly string[];
  start: boolean;
  /** The agents whose file already holds a token for someone else. */
  replacing?: Partial<Record<CodingAgentId, string>>;
}

const paths = (context: { env: NodeJS.ProcessEnv; home: string; platform: NodeJS.Platform }): AgentPaths =>
  ({ env: context.env, home: context.home, platform: context.platform });

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
const openclawConfigPath = (context: PlanContext): string => platformPath(context.platform).join(openclawHome(context.home, context.platform), "openclaw.json");
const openclawTokenPath = (context: PlanContext): string => platformPath(context.platform).join(openclawHome(context.home, context.platform), "secrets", `relay-${context.handle}.token`);

/** The agent's own command lines, exactly as this command runs them. */
export const agentCommands = (agent: CodingAgentId, context: PlanContext): string[][] => {
  const spec = mcpServerSpec(context);
  const envPairs = Object.entries(spec.env).map(([key, value]) => `${key}=${value}`);
  switch (agent) {
    case "claude-code":
      return [
        ["claude", "plugin", "marketplace", "add", claudeMarketplaceSource(context.version)],
        ["claude", "plugin", "install", CLAUDE_PLUGIN_ID, "--yes"],
        ["claude", "plugin", "enable", CLAUDE_PLUGIN_ID],
      ];
    case "codex":
      // `codex mcp add --help`: `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`, `--env <KEY=VALUE>`.
      return [["codex", "mcp", "add", MCP_SERVER_NAME, ...envPairs.flatMap((pair) => ["--env", pair]), "--", spec.command, ...spec.args]];
    case "gemini-cli":
      // `gemini mcp add [options] <name> <commandOrUrl> [args...]`, `-s user`
      // for ~/.gemini/settings.json; the server's own flags go after `--`
      // (measured 2026-09-10 in the lane sandbox: `-e` before the name swallows it).
      return [["gemini", "mcp", "add", "-s", "user", ...envPairs.map((pair) => `-e=${pair}`), MCP_SERVER_NAME, spec.command, "--", ...spec.args]];
    case "cline":
      // `cline mcp add --yes <name> -- <command> <args>` installs without the
      // wizard; it takes no environment, so the profile travels as a flag.
      return [["cline", "mcp", "add", "--yes", MCP_SERVER_NAME, "--", spec.command, ...spec.args]];
    case "hermes":
      return [["hermes", "plugins", "install", HERMES_PLUGIN_SOURCE, "--enable"]];
    case "openclaw":
      // OpenClaw stops on any npm source that is not ClawHub-reviewed unless
      // told `--force` ("Confirm non-ClawHub sources"), and refuses to enable a
      // plugin that declares capabilities unless told `--accept-capabilities`
      // (both from `openclaw plugins install --help`, measured on 2026.8.1 and
      // 2026.9.2 in the lane sandbox, 2026-09-10). The person confirmed this
      // plan, which names the install, so both confirmations pass through.
      return [["openclaw", "plugins", "install", openclawPluginSpec(context.version), "--force", "--accept-capabilities"]];
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
    case "mcp-file": return [method.file(paths(context))];
    case "hermes-plugin": return [hermesEnvPath(context)];
    case "openclaw-plugin": return [openclawTokenPath(context), openclawConfigPath(context)];
  }
};

/**
 * Every file this command writes and every command it runs for one agent, as
 * the lines the plan screen shows.
 */
export const agentPlan = (agent: CodingAgentId, context: PlanContext): AgentPlan => {
  const commands = agentCommands(agent, context).map((line) => line.join(" "));
  const files = agentFiles(agent, context);
  const replacing = context.replacing?.[agent];
  const write = (path: string, names: string): string =>
    `${replacing ? "replace the token already in" : "write"}  ${path}  (${names})`;
  const method = codingAgent(agent).connect;
  let steps: string[];
  switch (method.kind) {
    case "claude-plugin":
      steps = [
        `run  ${commands[0]}`,
        `run  ${commands[1]}, then  ${commands[2]}`,
        write(files[0]!, "token, API address, allowed senders"),
        ...(context.start ? ["start Claude Code with Relay when you are ready"] : []),
      ];
      break;
    case "mcp-command":
      steps = [
        `run  ${commands[0]}  (adds the Relay MCP server to ${files[0]})`,
        ...(context.start && codingAgent(agent).start?.kind === "bridge"
          ? [`keep running here, and answer your Relay messages with ${codingAgent(agent).label} from this folder`]
          : []),
      ];
      break;
    case "mcp-file":
      steps = [`add  ${mcpRootKey(method.shape)}.${MCP_SERVER_NAME}  to  ${files[0]}  (every other entry kept)`];
      break;
    case "hermes-plugin":
      steps = [
        `run  ${commands[0]}`,
        write(files[0]!, `token, API address, state folder${context.allow.length ? ", allowed contacts" : ""}`),
        ...(context.start ? ["start the Hermes gateway when you are ready:  hermes gateway run"] : []),
      ];
      break;
    case "openclaw-plugin":
      steps = [
        `run  ${commands[0]}`,
        write(files[0]!, "the token alone, owner-only"),
        `add  channels.relay  to  ${files[1]}  (every other setting kept)`,
        ...(context.start ? ["restart the OpenClaw gateway when you are ready"] : []),
      ];
      break;
  }
  return { agent, steps, files, commands };
};

/**
 * Every file this command writes and every command it runs, for every chosen
 * agent, on one screen before anything changes.
 */
export const runtimeConnectPlan = (input: PlanContext & { agents: readonly CodingAgentId[]; agentStep?: string; ask?: boolean }): ConnectPlan => {
  const agents = input.agents.map((agent) => agentPlan(agent, input));
  const steps = [...(input.agentStep ? [input.agentStep] : []), ...agents.flatMap((plan) => plan.steps)];
  // With `--non-interactive` no one can answer, so the plan is a statement:
  // clig.dev, Interactivity: "If --no-input is passed, don't prompt or do
  // anything interactive" (ledger row P27, captures/relay/ni2.out).
  const count = `Relay will do ${steps.length} ${steps.length === 1 ? "thing" : "things"}.`;
  return { headline: input.ask === false ? count : `${count} Continue?`, steps: numbered(steps), agents };
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
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const defaultStartCommand = async (file: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: "inherit", windowsHide: true });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });

interface Screen {
  say(line: string): void;
  step(line: string): void;
  /** A headline and its numbered steps, drawn as one block inside the gutter. */
  block(headline: string, steps: readonly string[]): void;
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

/** Adds `channels.relay` to openclaw.json (packages/openclaw/README.md, "Configure the channel"). */
export const writeOpenclawChannel = async (path: string, values: { baseURL: string; tokenFile: string; allowFrom: readonly string[] }): Promise<void> => {
  const root = await readJsonConfig(path, "channels.relay");
  const relay = objectAt(objectAt(root, "channels"), "relay");
  relay.enabled = true;
  relay.baseUrl = values.baseURL;
  relay.tokenFile = values.tokenFile;
  delete relay.token;
  if (values.allowFrom.length) relay.allowFrom = [...values.allowFrom];
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
    const line = [name, ...args].join(" ");
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
  const ui = options.nonInteractive ? undefined : deps.prompts;
  const json = options.json === true;
  const screen: Screen = {
    json,
    say: (line) => { if (!json) deps.stdout(`${line}\n`); },
    step: (line) => { if (json) return; if (ui) ui.step(line); else deps.stdout(`${line}\n`); },
    block: (headline, steps) => {
      if (json) return;
      if (ui) ui.step([headline, ...steps].join("\n"));
      else deps.stdout(`${[headline, ...steps].join("\n")}\n`);
    },
  };
  const platform = deps.platform ?? process.platform;
  const runtimes = await (deps.sniff ?? sniffRuntimes)({ env: deps.env, home: deps.home, platform });
  if (ui && !json) ui.intro("Relay");
  // The "Agent detected" line is said once per run by runCLI, for every command.
  const targets = await chooseAgents(requested, options, runtimes, deps);
  for (const target of targets) {
    const selected = runtimes.find((runtime) => runtime.id === target);
    screen.step(selected?.found
      ? `${selected.label} found  ${selected.executable ?? selected.configPath ?? "on this computer"}`
      // Named outright, so Relay goes on and lets the agent's own command say
      // what is wrong; it never claims to have found something it did not.
      : `${codingAgent(target).label} was not found on this computer; you named it, so Relay will try anyway`);
  }

  const version = deps.version ?? packageVersion();
  const allow = (options.allow ?? "").split(",").map((entry) => entry.trim().replace(/^@/u, "")).filter(Boolean);
  const context = (agent: ConnectAgent | undefined, replacing?: PlanContext["replacing"]): PlanContext => ({
    env: deps.env, home: deps.home, platform, version,
    profile: agent?.profile ?? deps.profile ?? "<profile>",
    handle: agent?.handle ?? options.handle ?? "<handle>",
    allow, start: options.start !== false,
    ...(replacing ? { replacing } : {}),
  });

  if (options.dryRun === true) {
    // A dry run reads nothing private, creates nothing and asks nothing, so the
    // whole plan is printable before an agent exists.
    const dry = runtimeConnectPlan({
      ...context(undefined), agents: targets, ask: options.nonInteractive !== true,
      agentStep: options.token === undefined
        ? "create a new agent and save its token privately on this computer"
        : "use the agent whose token you passed with --token",
    });
    screen.block(dry.headline, dry.steps);
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

  const agent = await resolveAgent(options, deps);
  const secrets = [agent.token];
  screen.step(safeMetadata(`${agent.created ? "Created" : "That token is"} @${agent.handle}  token saved privately on this computer`, secrets));

  // A token already in a .env file belongs to whatever answers as that agent
  // today, so it is never replaced without being told to.
  const replacing: PlanContext["replacing"] = {};
  for (const target of targets) {
    const path = target === "claude-code" ? join(claudeChannelDir(deps.env, deps.home), ".env")
      : target === "hermes" ? hermesEnvPath(context(agent)) : undefined;
    if (!path) continue;
    let existing: string | undefined;
    try { existing = readChannelEnv(await readFile(path, "utf8")).RELAY_AGENT_TOKEN; } catch { /* No file yet. */ }
    if (!existing || existing === agent.token) continue;
    const config = await deps.agents.read();
    const owner = Object.entries(config.profiles).find(([, profile]) => profile.agent_token === existing)?.[0];
    replacing[target] = owner ? `@${owner}` : "another agent";
    if (options.yes === true) continue;
    if (!ui || json) {
      throw new HeadlessPrompt(`${path} already holds a token for ${replacing[target]}.`, ["--yes  to replace it with the agent you are connecting"]);
    }
    const answer = await ui.select(`${codingAgent(target).label} already has a Relay token for ${replacing[target]}. Keep it, or replace it with @${agent.handle}?`, [
      { value: "keep", label: "Keep" },
      { value: "replace", label: "Replace" },
    ]);
    if (answer !== "replace") {
      screen.say(`Kept the token for ${replacing[target]}. Nothing was changed there. Your agent and its token are saved on this computer.`);
      return;
    }
  }

  const plan = runtimeConnectPlan({ ...context(agent, replacing), agents: targets, ask: options.nonInteractive !== true });
  screen.block(plan.headline, plan.steps);
  if (options.yes !== true) {
    if (!ui || json) throw new HeadlessPrompt("Relay cannot ask you to confirm this plan.", ["--yes  to run the plan above"]);
    if (!await ui.confirm("Continue?")) throw new InteractiveCancelled();
  }

  const runCommand = deps.runCommand ?? defaultRunCommand;
  const done: Array<Record<string, unknown>> = [];
  const allowed = [...allow];
  const starts: Array<{ command: string; args: string[]; label: string }> = [];
  let bridge: { label: string; command: string } | undefined;
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
      await runAgentCommands(target, runtime, ctx, runCommand);
      screen.step("Plugin installed");
      await writeChannelEnv(channelDir, { token: agent.token, baseURL: agent.apiURL, allowedSenders: allowed }, platform);
      screen.step(`Config written, owner-only  ${envPath}`);
      if (!allowed.length) {
        const paired = await pairFirstSender(agent, deps, screen);
        if (paired) {
          allowed.push(paired);
          await writeChannelEnv(channelDir, { token: agent.token, baseURL: agent.apiURL, allowedSenders: allowed }, platform);
          screen.step(`Allowed: @${paired}`);
        }
      }
      Object.assign(result, { env_path: envPath, plugin: CLAUDE_PLUGIN_ID, marketplace: claudeMarketplaceSource(version), allowed_senders: allowed });
    } else if (method.kind === "mcp-command") {
      await runAgentCommands(target, runtime, ctx, runCommand);
      screen.step(`Relay MCP server added to ${codingAgent(target).label}  ${planned.files[0]}`);
    } else if (method.kind === "mcp-file") {
      await writeMcpFileEntry(planned.files[0]!, method.shape, mcpServerSpec(ctx));
      screen.step(`Relay MCP server added to ${codingAgent(target).label}  ${planned.files[0]}`);
    } else if (method.kind === "hermes-plugin") {
      await runAgentCommands(target, runtime, ctx, runCommand);
      screen.step("Plugin installed");
      await writeEnvFile(hermesEnvPath(ctx), {
        RELAY_AGENT_TOKEN: agent.token,
        RELAY_BASE_URL: agent.apiURL,
        RELAY_STATE_DIR: hermesStateDir(ctx),
        ...(allowed.length ? { RELAY_ALLOWED_CONTACTS: allowed.join(",") } : {}),
      }, "Hermes", platform);
      screen.step(`Config written, owner-only  ${hermesEnvPath(ctx)}`);
      Object.assign(result, { env_path: hermesEnvPath(ctx), start_command: "hermes gateway run" });
    } else {
      await runAgentCommands(target, runtime, ctx, runCommand);
      screen.step("Plugin installed");
      const tokenPath = openclawTokenPath(ctx);
      const destination = await preparePrivateDestination(tokenPath, "OpenClaw secrets", platform);
      await writePrivateDestination(destination, ".relay-connect", `${agent.token}\n`);
      await writeOpenclawChannel(openclawConfigPath(ctx), { baseURL: agent.apiURL, tokenFile: tokenPath, allowFrom: allowed });
      screen.step(`Config written  ${openclawConfigPath(ctx)}  token owner-only in  ${tokenPath}`);
      Object.assign(result, { token_file: tokenPath, config_path: openclawConfigPath(ctx) });
    }
    const start = definition.start;
    if (start?.kind === "bridge") {
      const command = runtime?.executable ?? start.command;
      result.bridge_command = command;
      if (!json && options.start !== false) {
        // `--yes` already took a plan whose last step is this one, so it is not
        // asked twice; without it, this is the one question left to answer.
        const accepted = options.yes === true || (ui !== undefined && await ui.confirm(start.prompt));
        if (accepted) bridge = { label: definition.label, command };
        else screen.say(`${definition.label} answers when you ask it to read your Relay messages.`);
      }
    } else if (start?.kind === "command") {
      const command = runtime?.executable ?? start.command;
      const commandLine = [command, ...start.args].join(" ");
      result.start_command = commandLine;
      if (!json) {
        const accepted = options.start !== false && Boolean(ui) && await ui!.confirm(start.prompt);
        if (accepted) {
          starts.push({ command, args: start.args, label: definition.label });
        } else {
          screen.say(`Start it yourself when you are ready:  ${commandLine}`);
        }
      }
    } else if (start?.kind === "restart" && !json) {
      screen.say(start.instruction);
    }
    done.push(result);
  }

  if (json) {
    deps.stdout(`${JSON.stringify(safeMetadata({
      ok: true, profile: agent.profile, handle: agent.handle, api_url: agent.apiURL, token: "stored", agents: done, proof: "skipped",
    }, secrets), null, 2)}\n`);
  } else {
    screen.say(`Relay is ready for ${targets.map((target) => codingAgent(target).label).join(", ")}.`);
    // Docker MCP's line after a connect (cmd/docker-mcp/client/connect.go:30).
    for (const target of targets) {
      if (!codingAgent(target).start && codingAgent(target).connect.kind === "mcp-file") screen.say(`You might have to restart '${codingAgent(target).label}'.`);
    }
    for (const start of starts) screen.say(`${start.label} opens next.`);
    screen.say(`Later:  relay watch ${agent.handle}  ·  relay doctor`);
  }
  if (options.skill !== false && deps.offerSkill && !json) await deps.offerSkill();
  if (!json) {
    screen.say(`Say anything to @${agent.handle} from your phone.`);
    if (bridge && deps.bridge) {
      screen.say(`${bridge.label} answers your Relay messages from ${deps.cwd}. Press Control-C to stop.`);
      await deps.bridge({
        token: agent.token, apiURL: agent.apiURL, command: bridge.command, cwd: deps.cwd,
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
      const reply = await proof;
      screen.say(reply === undefined
        ? `No reply yet. Run:  relay watch @${agent.handle}`
        : `Answered from your phone: ${reply}`);
    }
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
 * Which agents to connect. A name on the command line decides; `--all` takes
 * every detected one; a terminal asks with the detected ones pre-selected; a
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
  if (options.all === true) {
    if (!found.length) {
      throw new ConnectFailure(`No coding agent was found on this computer. Name one instead. ${supportedAgentsLine()}`, "npx relaymessenger connect <agent>");
    }
    return found;
  }
  if (deps.drivingAgent) return [deps.drivingAgent];
  if (!deps.prompts || options.json) throw new HeadlessPrompt(NO_TTY_SENTENCE, [], NO_TTY_NEXT_STEP);
  const picked = await deps.prompts.multiselect(
    "Which coding agents should Relay connect?\n  Detected agents are pre-selected",
    CODING_AGENTS.map((agent) => ({ value: agent.id, label: found.includes(agent.id) ? `${agent.label}  found on this computer` : agent.label })),
    found,
  );
  const chosen = CODING_AGENT_IDS.filter((id) => picked.includes(id));
  if (!chosen.length) throw new InteractiveCancelled();
  return chosen;
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
    return name;
  });
  return { profile, handle, displayName, apiURL, token, created: false, shareURL: savedAgentShareURL(apiURL, handle) };
};

const resolveAgent = async (options: ConnectOptions, deps: ConnectDependencies): Promise<ConnectAgent> => {
  const apiURL = validateApiURL(options.apiUrl ?? deps.env.RELAY_API_URL ?? defaultCreationApiURL(deps.version));
  if (options.token !== undefined) return saveExistingAgent(options.token, apiURL, deps);
  if (options.new !== true) {
    if (!deps.prompts || options.json) {
      throw new HeadlessPrompt("Relay cannot ask which agent to connect.", [
        "--new  to create one, with --handle and --name if you want to choose them",
        "--token <token>  to use an agent you already have",
      ]);
    }
    const answer = await deps.prompts.select("Which agent?", [
      { value: "new", label: "Create a new agent" },
      { value: "token", label: "Use an agent I already have  (paste its token)" },
    ]);
    if (answer === "token") return saveExistingAgent(await deps.prompts.password("Paste the agent's token"), apiURL, deps);
  }
  let handle = options.handle;
  if (handle === undefined && deps.prompts && !options.json && options.yes !== true) {
    handle = (await deps.prompts.text("Handle  (press Enter and Relay picks one)", "")).trim() || undefined;
  }
  const created = await createAgentWithPicture({
    apiURL,
    ...(deps.profile ? { profile: deps.profile } : {}),
    ...(handle ? { handle } : {}),
    ...(options.name ? { firstName: options.name } : {}),
    ...(options.about === undefined ? {} : { about: options.about }),
    ...(options.image ? { image: options.image } : {}),
    cwd: deps.cwd,
    home: deps.home,
  }, deps.agents, deps.fetch);
  if (created.image && created.image.status !== "updated") {
    throw new ConnectFailure(
      incompletePictureMessage(created.result.handle, created.result.profile, created.image, false),
      `npx relaymessenger --profile ${created.result.profile} contact-card update --handle ${created.result.handle} --image <local-file>`,
    );
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
  const share = agent.shareURL || savedAgentShareURL(agent.apiURL, agent.handle);
  screen.step(`Add @${agent.handle} from your phone`);
  if (share) {
    // The QR holds the public link, never the token.
    try { deps.stdout(`${(deps.renderQR ?? renderTerminalQR)(share)}${share}\n`); }
    catch { deps.stdout(`${share}\n`); }
  }
  screen.say("Open Relay, scan, add this agent, then send it any message.");
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
