import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createAgentWithPicture, incompletePictureMessage } from "./agent-create.js";
import type { AgentDependencies } from "./agents.js";
import { savedAgentShareURL } from "./agent-session.js";
import {
  claudeChannelDir,
  normalizeRuntimeChoice,
  runtimeConfigPath,
  sniffRuntimes,
  type RuntimeChoice,
  type RuntimeFound,
  type RuntimeId,
  type RuntimeSniffContext,
} from "./runtime-sniff.js";
import { inspectChannelEnv, writeChannelEnv } from "./claude-channel.js";
import { defaultCreationApiURL, isStagingBuild, packageVersion, validateApiURL, validateProfileName, validateToken } from "./config.js";
import { HeadlessPrompt, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { renderTerminalQR } from "./qr-terminal.js";
import { safeMetadata } from "./output.js";
import type { TerminalObserver } from "./terminal-watch.js";

/** The plugin, and the marketplace it comes from, exactly as Claude Code names
 * them (.claude-plugin/marketplace.json: marketplace "relay-messenger", plugin "relay"). */
export const CLAUDE_MARKETPLACE_REPO = "RelayMessenger/Relay-SDK";
export const CLAUDE_PLUGIN_ID = "relay@relay-messenger";
/** A `-staging` build installs the plugin from `staging` and a release from
 * `main`, the same rule the Relay skill installer already follows. */
export const claudeMarketplaceSource = (version: string = packageVersion()): string =>
  `${CLAUDE_MARKETPLACE_REPO}@${isStagingBuild(version) ? "staging" : "main"}`;
/** Relay is not yet on the default channel allowlist, so a custom start is
 * required during the research preview (packages/claude-code/README.md). */
export const CLAUDE_START_ARGS = ["--dangerously-load-development-channels", `plugin:${CLAUDE_PLUGIN_ID}`] as const;
/** Pairing waits this long for a first message before it names --allow instead. */
export const PAIR_TIMEOUT_MS = 180_000;

export interface ConnectOptions {
  new?: boolean;
  handle?: string;
  name?: string;
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
  sniff?: (context: RuntimeSniffContext) => Promise<RuntimeFound[]>;
  /** Runs one of the runtime's own commands and waits for it. */
  runCommand?: (file: string, args: readonly string[]) => Promise<ConnectCommandResult>;
  /** Hands this terminal to the runtime. */
  startCommand?: (file: string, args: readonly string[]) => Promise<number>;
  observer?: (token: string, apiURL: string) => TerminalObserver | undefined;
  renderQR?: (url: string) => string;
  pairTimeoutMs?: number;
  version?: string;
  fetch?: typeof globalThis.fetch;
  offerSkill?: () => Promise<void>;
}

/** A failure a person can act on: the sentence, and the next thing to run. */
export class ConnectFailure extends Error {
  constructor(message: string, readonly nextStep: string) { super(message); }
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

export interface ConnectPlan {
  headline: string;
  steps: string[];
}

const numbered = (steps: readonly string[]): string[] =>
  steps.map((line, index) => `  ${index + 1}  ${line}`);

/**
 * Every file this command writes and every command it runs, on one screen,
 * before anything changes. The Hermes and OpenClaw steps are the ones the design
 * note fixes (Relay-Design/design/relay-cli-ideal-20260909.md, section 6); this
 * build prints them and stops, because it writes only Claude Code.
 */
export const runtimeConnectPlan = (input: {
  runtime: RuntimeId;
  env: NodeJS.ProcessEnv;
  home: string;
  handle?: string;
  marketplaceSource: string;
  agentStep?: string;
  replacing?: string;
  start: boolean;
}): ConnectPlan => {
  const claudeEnv = join(claudeChannelDir(input.env, input.home), ".env");
  const write = (path: string, names: string): string =>
    `${input.replacing ? "replace the token already in" : "write"}  ${path}  (${names})`;
  const runtimeSteps: Record<RuntimeId, string[]> = {
    claude: [
      `run  claude plugin marketplace add ${input.marketplaceSource}`,
      `run  claude plugin install ${CLAUDE_PLUGIN_ID} --yes, then  claude plugin enable ${CLAUDE_PLUGIN_ID}`,
      write(claudeEnv, "token, API address, allowed senders"),
      ...(input.start ? ["start Claude Code with Relay when you are ready"] : []),
    ],
    hermes: [
      "run  hermes plugins install RelayMessenger/Relay-Hermes --enable",
      write(join(runtimeConfigPath("hermes", { env: input.env, home: input.home }), ".env"), "token, API address, data folder, allowed contacts"),
      ...(input.start ? ["start the Hermes gateway"] : []),
    ],
    openclaw: [
      "run  openclaw plugins install @relaymessenger/openclaw-plugin",
      write(join(input.home, ".openclaw", "secrets", `relay-${input.handle ?? "<handle>"}.token`), "the token alone, owner-only"),
      `add  channels.relay  to  ${runtimeConfigPath("openclaw", { env: input.env, home: input.home })}  (every other setting kept)`,
      ...(input.start ? ["restart the OpenClaw gateway"] : []),
    ],
  };
  const steps = [...(input.agentStep ? [input.agentStep] : []), ...runtimeSteps[input.runtime]];
  return { headline: `Relay will do ${steps.length} things. Continue?`, steps: numbered(steps) };
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
 * so the runtime being connected still receives every message.
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
  json: boolean;
}

export const runConnect = async (
  requested: string | undefined,
  options: ConnectOptions,
  deps: ConnectDependencies,
): Promise<void> => {
  const ui = deps.prompts;
  const json = options.json === true;
  const screen: Screen = {
    json,
    say: (line) => { if (!json) deps.stdout(`${line}\n`); },
    step: (line) => { if (json) return; if (ui) ui.step(line); else deps.stdout(`${line}\n`); },
  };
  const runtimes = await (deps.sniff ?? sniffRuntimes)({
    env: deps.env, home: deps.home, ...(deps.platform ? { platform: deps.platform } : {}),
  });
  if (ui && !json) ui.intro("Relay");
  const choice = await chooseRuntime(requested, options, runtimes, deps);
  const selected = choice === "other" ? undefined : runtimes.find((runtime) => runtime.id === choice);
  if (!selected) {
    throw new ConnectFailure(
      "Relay does not write configuration for that yet. Create the agent with  npx relaymessenger agents create  and use its token in your own code.",
      "npx relaymessenger agents create",
    );
  }
  screen.step(`${selected.label} found  ${selected.executable ?? selected.configPath ?? "on this computer"}`);
  const marketplaceSource = claudeMarketplaceSource(deps.version);
  if (selected.id !== "claude") {
    // Detection and the plan only. Nothing is written for these runtimes yet.
    const plan = runtimeConnectPlan({
      runtime: selected.id, env: deps.env, home: deps.home, marketplaceSource, start: options.start !== false,
      agentStep: "create a new agent and save its token privately on this computer",
    });
    screen.say(plan.headline.replace("will do", "would do"));
    for (const line of plan.steps) screen.say(line);
    throw new ConnectFailure(
      `${selected.label} is not yet supported in this build. Nothing was changed.`,
      "npx relaymessenger connect claude",
    );
  }
  await connectClaude(selected, options, deps, screen, marketplaceSource);
};

const chooseRuntime = async (
  requested: string | undefined,
  options: ConnectOptions,
  runtimes: readonly RuntimeFound[],
  deps: ConnectDependencies,
): Promise<RuntimeChoice> => {
  if (requested !== undefined) {
    const normalized = normalizeRuntimeChoice(requested);
    if (!normalized) {
      throw new ConnectFailure("Name one of: claude, hermes, openclaw. Leave it out and Relay asks.", "npx relaymessenger connect");
    }
    return normalized;
  }
  const found = runtimes.filter((runtime) => runtime.found);
  if (!deps.prompts || options.json) {
    throw new HeadlessPrompt("Relay cannot ask which runtime should answer as this agent.", [
      `name the runtime after the command, for example  connect ${found[0]?.id ?? "claude"}`,
    ]);
  }
  if (!found.length) {
    throw new ConnectFailure(
      "No runtime found on this computer. Install Claude Code, Hermes or OpenClaw, or create the agent with  npx relaymessenger agents create  and use its token in your own code.",
      "npx relaymessenger agents create",
    );
  }
  const answer = await deps.prompts.select("What will answer as this agent?", [
    ...found.map((runtime) => ({ value: runtime.id, label: `${runtime.label}  found on this computer` })),
    { value: "other", label: "Something else  (any backend: I have a token, or start from code)" },
  ]);
  return normalizeRuntimeChoice(answer) ?? "other";
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
      "npx relaymessenger connect claude --token <token>",
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

const connectClaude = async (
  runtime: RuntimeFound,
  options: ConnectOptions,
  deps: ConnectDependencies,
  screen: Screen,
  marketplaceSource: string,
): Promise<void> => {
  const ui = deps.prompts;
  const channelDir = claudeChannelDir(deps.env, deps.home);
  const envPath = join(channelDir, ".env");
  const claude = runtime.executable ?? "claude";
  const plan = (extra: { replacing?: string; agentStep?: string }): ConnectPlan => runtimeConnectPlan({
    runtime: "claude", env: deps.env, home: deps.home, marketplaceSource, start: options.start !== false, ...extra,
  });

  if (options.dryRun === true) {
    // A dry run reads nothing private, creates nothing and asks nothing, so the
    // whole plan is printable before an agent exists.
    const dry = plan({
      agentStep: options.token === undefined
        ? "create a new agent and save its token privately on this computer"
        : "use the agent whose token you passed with --token",
    });
    screen.say(dry.headline);
    for (const line of dry.steps) screen.say(line);
    screen.say("Dry run: nothing was changed.");
    if (screen.json) {
      deps.stdout(`${JSON.stringify({
        ok: true, runtime: "claude", dry_run: true, env_path: envPath,
        marketplace: marketplaceSource, plugin: CLAUDE_PLUGIN_ID,
        steps: dry.steps.map((line) => line.trim()),
      }, null, 2)}\n`);
    }
    return;
  }

  const agent = await resolveAgent(options, deps);
  const secrets = [agent.token];
  screen.step(safeMetadata(`${agent.created ? "Created" : "That token is"} @${agent.handle}  token saved privately on this computer`, secrets));

  // A token already in this file belongs to whatever answers as that agent
  // today, so it is never replaced without being told to.
  const existing = await inspectChannelEnv(channelDir);
  let replacing: string | undefined;
  if (existing.token && existing.token !== agent.token) {
    const config = await deps.agents.read();
    const owner = Object.entries(config.profiles).find(([, profile]) => profile.agent_token === existing.token)?.[0];
    replacing = owner ? `@${owner}` : "another agent";
    if (options.yes !== true) {
      if (!ui || options.json) {
        throw new HeadlessPrompt(`${envPath} already holds a token for ${replacing}.`, [
          "--yes  to replace it with the agent you are connecting",
        ]);
      }
      const answer = await ui.select(`Claude Code already has a Relay token for ${replacing}. Keep it, or replace it with @${agent.handle}?`, [
        { value: "keep", label: "Keep" },
        { value: "replace", label: "Replace" },
      ]);
      if (answer !== "replace") {
        screen.say(`Kept the token for ${replacing}. Nothing was changed there. Your agent and its token are saved on this computer.`);
        return;
      }
    }
  }

  const confirmed = plan(replacing ? { replacing } : {});
  screen.say(confirmed.headline);
  for (const line of confirmed.steps) screen.say(line);
  if (options.yes !== true) {
    if (!ui || options.json) throw new HeadlessPrompt("Relay cannot ask you to confirm this plan.", ["--yes  to run the plan above"]);
    if (!await ui.confirm("Continue?")) throw new InteractiveCancelled();
  }

  const runCommand = deps.runCommand ?? defaultRunCommand;
  for (const args of [
    ["plugin", "marketplace", "add", marketplaceSource],
    ["plugin", "install", CLAUDE_PLUGIN_ID, "--yes"],
    ["plugin", "enable", CLAUDE_PLUGIN_ID],
  ]) {
    const outcome = await runCommand(claude, args);
    if (outcome.code !== 0) {
      // The runtime's own words first, then what is true about Relay's side.
      const said = `${outcome.stderr}\n${outcome.stdout}`.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
      throw new ConnectFailure(
        `claude ${args.join(" ")} did not finish.${said ? ` It said: ${said}` : ""} Nothing else was changed; your agent and its token are saved. Run the same command again.`,
        "npx relaymessenger connect claude --yes",
      );
    }
  }
  screen.step("Plugin installed");

  const allowed = (options.allow ?? "").split(",").map((entry) => entry.trim().replace(/^@/u, "")).filter(Boolean);
  await writeChannelEnv(channelDir, { token: agent.token, baseURL: agent.apiURL, allowedSenders: allowed }, deps.platform);
  screen.step(`Config written, owner-only  ${envPath}`);

  if (!allowed.length) {
    const paired = await pairFirstSender(agent, deps, screen);
    if (paired) {
      allowed.push(paired);
      await writeChannelEnv(channelDir, { token: agent.token, baseURL: agent.apiURL, allowedSenders: allowed }, deps.platform);
      screen.step(`Allowed: @${paired}`);
    }
  }

  const startLine = `${claude} ${CLAUDE_START_ARGS.join(" ")}`;
  const start = options.start !== false && Boolean(ui) && !options.json
    ? await ui!.confirm("Start Claude Code with Relay now?")
    : false;
  if (screen.json) {
    deps.stdout(`${JSON.stringify(safeMetadata({
      ok: true, runtime: "claude", profile: agent.profile, handle: agent.handle,
      api_url: agent.apiURL, env_path: envPath, plugin: CLAUDE_PLUGIN_ID,
      marketplace: marketplaceSource, allowed_senders: allowed, token: "stored",
      start_command: startLine,
    }, secrets), null, 2)}\n`);
  } else {
    screen.say("Relay is ready for Claude Code.");
    screen.say(start
      ? `Claude opens next. Say anything to @${agent.handle} from your phone; the answer shows here and on your phone.`
      : `Start it yourself when you are ready:  ${startLine}`);
    screen.say(`Later:  relay watch ${agent.handle}  ·  relay doctor`);
  }
  if (options.skill !== false && deps.offerSkill && !options.json) await deps.offerSkill();
  if (start) await (deps.startCommand ?? defaultStartCommand)(claude, CLAUDE_START_ARGS);
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
    screen.say("No message arrived. Run  npx relaymessenger connect claude --allow <your handle>  to allow a sender without waiting.");
    return undefined;
  }
  return await ui.confirm(`Allow @${sender.handle} to message this agent?`) ? sender.handle : undefined;
};
