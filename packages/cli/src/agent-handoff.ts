import { safeMetadata } from "./output.js";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import type { AgentDependencies } from "./agents.js";
import { DEFAULT_API_URL, validateApiURL, validateToken } from "./config.js";
import { applyRuntimeConnect, planRuntimeConnect, type RuntimeConnectTarget } from "./runtime-connect.js";

export interface ConnectOptions {
  connect?: string;
  runtimeHome?: string;
  runtimeConfig?: string;
  runtimeStateDir?: string;
  runtimeAccount?: string;
  runtimeBrain?: string;
  runtimeContext?: string;
  confirmConfigure?: boolean;
  runtimeStopped?: boolean;
}
export function connectOptions(command: Command): Command {
  return command.option("--connect <runtime>", "save the token into Claude Code, Hermes or OpenClaw; does not start it")
    .option("--runtime-home <path>", "full path to the Hermes profile folder, or to the Claude Code folder for this session")
    .option("--runtime-config <path>", "full path to your existing OpenClaw config file")
    .option("--runtime-state-dir <path>", "full path to the folder where that runtime keeps its saved data")
    .option("--runtime-account <name>", "the Relay account name in OpenClaw")
    .option("--runtime-brain <id>", "the OpenClaw brain already linked to that account")
    .option("--runtime-context <id>", "a name for this Claude Code session")
    .option("--confirm-configure", "yes, write the token into that one configuration file")
    .option("--runtime-stopped", "yes, I have stopped the runtime I chose");
}
async function nativePath(value: string | undefined, name: string, file = false): Promise<string> {
  if (!value || !isAbsolute(value)) throw new Error(`${name} needs a full path that starts at the root of the disk.`);
  // The user selects the context; resolve directory aliases, never linked config files.
  return file ? join(await realpath(dirname(value)), basename(value)) : await realpath(value);
}
async function requiredNativeFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("That configuration file does not exist, or it is a link or a folder. Give the path to a real file.");
  return path;
}
export async function connectTarget(options: ConnectOptions): Promise<RuntimeConnectTarget | undefined> {
  if (!options.connect) {
    if (Object.entries(options).some(([key, value]) => (key.startsWith("runtime") || key === "confirmConfigure") && value !== undefined)) throw new Error("The --runtime options only work together with --connect. Add --connect claude-code, --connect hermes or --connect openclaw.");
    return undefined;
  }
  if (!options.confirmConfigure || !options.runtimeStopped) throw new Error("Stop the runtime you chose, then run this again with --confirm-configure and --runtime-stopped.");
  if (options.connect === "openclaw") {
    if (!options.runtimeAccount) throw new Error("Pass --runtime-account with the name of the Relay account in your OpenClaw config file.");
    return { runtime: "openclaw", configPath: await requiredNativeFile(await nativePath(options.runtimeConfig, "--runtime-config", true)), stateDir: await nativePath(options.runtimeStateDir, "--runtime-state-dir", true), account: options.runtimeAccount, ...(options.runtimeBrain ? { brain: options.runtimeBrain } : {}) };
  }
  if (options.connect === "hermes") {
    const profileHome = await nativePath(options.runtimeHome, "--runtime-home");
    await requiredNativeFile(join(profileHome, "config.yaml"));
    return { runtime: "hermes", profileHome, stateDir: await nativePath(options.runtimeStateDir, "--runtime-state-dir", true) };
  }
  if (options.connect === "claude-code") {
    if (!options.runtimeContext?.trim()) throw new Error("Pass --runtime-context with a name for this Claude Code session.");
    const channelDir = await nativePath(options.runtimeHome, "--runtime-home");
    await requiredNativeFile(join(channelDir, ".env"));
    return { runtime: "claude-code", channelDir, context: options.runtimeContext };
  }
  throw new Error("--connect must be openclaw, hermes, or claude-code.");
}

export async function connectAgentToRuntime(target: RuntimeConnectTarget, profile: string | undefined, deps: AgentDependencies, confirmation: { consent: boolean; runtimeStopped: boolean }, savedProfileOnly = false) {
  if (confirmation.consent !== true || confirmation.runtimeStopped !== true) throw new Error("Pass both --confirm-configure and --runtime-stopped to write the configuration.");
  // Read the token just created or just saved; the environment must not swap in another agent.
  const saved = savedProfileOnly ? (await deps.read()).profiles[profile!] : undefined;
  if (savedProfileOnly && !saved?.agent_token) throw new Error("This profile has no saved token. Nothing was changed. Sign in for this profile first.");
  const auth = savedProfileOnly
    ? { token: validateToken(saved!.agent_token!), apiURL: validateApiURL(saved!.api_url ?? DEFAULT_API_URL), profile: profile! }
    : await deps.auth(profile);
  let cards;
  try { cards = await deps.client(auth.token, auth.apiURL).contactCard.retrieve(); }
  catch { throw new Error("Relay would not accept this token, so nothing was changed and no agent was created."); }
  const agents = cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active);
  if (agents.length !== 1) throw new Error("This token must belong to exactly one active agent. Use a token for a single agent.");
  const plan = await planRuntimeConnect({ agent: { token: auth.token, origin: auth.apiURL, handle: agents[0]!.handle }, target });
  const result = plan.status === "ready" ? await applyRuntimeConnect(plan, { consent: confirmation.consent, runtimeStopped: confirmation.runtimeStopped }) : plan;
  // Never write out private input, plan internals, undo handles, or raw errors.
  return safeMetadata({ profile: auth.profile, handle: agents[0]!.handle, runtime: target.runtime, status: result.status, code: result.code, message: result.message, connected: false }, [auth.token]);
}
