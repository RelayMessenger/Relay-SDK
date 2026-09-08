import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import type { AgentDependencies } from "./agents.js";
import { DEFAULT_API_URL, validateApiURL, validateToken } from "./config.js";
import { applyRuntimeConnect, planRuntimeConnect, type RuntimeConnectTarget } from "./runtime-connect.js";

export interface HandoffOptions {
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
export function handoffOptions(command: Command): Command {
  return command.option("--connect <runtime>", "configure openclaw, hermes, or claude-code; does not launch it")
    .option("--runtime-home <path>", "absolute Hermes profile home or Claude session channel directory")
    .option("--runtime-config <path>", "absolute existing OpenClaw config file")
    .option("--runtime-state-dir <path>", "absolute selected runtime state directory")
    .option("--runtime-account <name>", "explicit OpenClaw Relay account")
    .option("--runtime-brain <id>", "existing OpenClaw brain binding")
    .option("--runtime-context <id>", "explicit Claude session context")
    .option("--confirm-configure", "consent to writing only the selected runtime credential config")
    .option("--runtime-stopped", "confirm you have stopped the selected runtime before configuration");
}
async function nativePath(value: string | undefined, name: string, file = false): Promise<string> {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must select an absolute native path.`);
  // The user selects the context; resolve directory aliases, never linked config files.
  return file ? join(await realpath(dirname(value)), basename(value)) : await realpath(value);
}
async function requiredNativeFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Select an existing regular native runtime configuration file.");
  return path;
}
export async function handoffTarget(options: HandoffOptions): Promise<RuntimeConnectTarget | undefined> {
  if (!options.connect) {
    if (Object.entries(options).some(([key, value]) => (key.startsWith("runtime") || key === "confirmConfigure") && value !== undefined)) throw new Error("Runtime options require --connect.");
    return undefined;
  }
  if (!options.confirmConfigure || !options.runtimeStopped) throw new Error("Handoff requires --confirm-configure and --runtime-stopped after you stop the selected runtime.");
  if (options.connect === "openclaw") {
    if (!options.runtimeAccount) throw new Error("Select --runtime-account explicitly.");
    return { runtime: "openclaw", configPath: await requiredNativeFile(await nativePath(options.runtimeConfig, "--runtime-config", true)), stateDir: await nativePath(options.runtimeStateDir, "--runtime-state-dir", true), account: options.runtimeAccount, ...(options.runtimeBrain ? { brain: options.runtimeBrain } : {}) };
  }
  if (options.connect === "hermes") {
    const profileHome = await nativePath(options.runtimeHome, "--runtime-home");
    await requiredNativeFile(join(profileHome, "config.yaml"));
    return { runtime: "hermes", profileHome, stateDir: await nativePath(options.runtimeStateDir, "--runtime-state-dir", true) };
  }
  if (options.connect === "claude-code") {
    if (!options.runtimeContext?.trim()) throw new Error("Select --runtime-context explicitly.");
    const channelDir = await nativePath(options.runtimeHome, "--runtime-home");
    await requiredNativeFile(join(channelDir, ".env"));
    return { runtime: "claude-code", channelDir, context: options.runtimeContext };
  }
  throw new Error("--connect must be openclaw, hermes, or claude-code.");
}

export async function handoffAgent(target: RuntimeConnectTarget, profile: string | undefined, deps: AgentDependencies, confirmation: { consent: boolean; runtimeStopped: boolean }, newlyCreated = false) {
  if (confirmation.consent !== true || confirmation.runtimeStopped !== true) throw new Error("Explicit handoff consent and runtime stop confirmation are required.");
  // Creation selected a NEW saved credential: ENV must never substitute another agent.
  const saved = newlyCreated ? (await deps.read()).profiles[profile!] : undefined;
  if (newlyCreated && !saved?.agent_token) throw new Error("Created profile credential is unavailable; no runtime config was changed.");
  const auth = newlyCreated
    ? { token: validateToken(saved!.agent_token!), apiURL: validateApiURL(saved!.api_url ?? DEFAULT_API_URL), profile: profile! }
    : await deps.auth(profile);
  let cards;
  try { cards = await deps.client(auth.token, auth.apiURL).contactCard.retrieve(); }
  catch { throw new Error("Existing credential validation failed; no runtime config changed and no agent was created by setup."); }
  const agents = cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active);
  if (agents.length !== 1) throw new Error("Select a credential with exactly one active agent Contact Card before handoff.");
  const plan = await planRuntimeConnect({ agent: { token: auth.token, origin: auth.apiURL, handle: agents[0]!.handle }, target });
  const result = plan.status === "ready" ? await applyRuntimeConnect(plan, { consent: confirmation.consent, runtimeStopped: confirmation.runtimeStopped }) : plan;
  // Do not serialize private input, plan internals, rollback capabilities, or errors.
  return { profile: auth.profile, handle: agents[0]!.handle, runtime: target.runtime, status: result.status, code: result.code, message: result.message, connected: false };
}
