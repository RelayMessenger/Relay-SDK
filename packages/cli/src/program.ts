import { openSavedAgentSession, type AgentSessionInput, type AgentSessionDependencies } from "./agent-session.js";
import { prepareAgentImage } from "./local-image.js";
import { uploadAgentImage } from "./agent-image-upload.js";
import { createAgentWithPicture, incompletePictureMessage } from "./agent-create.js";
import { homedir } from "node:os";
import { clackPrompts, chooseInteractiveCommand, interactiveAllowed, interactiveEntry, HeadlessPrompt, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { runConnect, ConnectFailure, type ConnectOptions as ConnectRunOptions } from "./connect.js";
import { codexCommand, runCodexBridge } from "./codex-bridge.js";
import { openCodexThreads } from "./codex-threads.js";
import { acpCommand, relayMcpServer, runAcpBridge } from "./acp-bridge.js";
import { openAcpSessions } from "./acp-threads.js";
import { sdkTerminalObserver, terminalEventLine } from "./terminal-watch.js";
import { dim, link } from "./ui-colour.js";
import { installRelaySkill, relaySkillGlobalArgs, relaySkillPresent } from "./skill-offer.js";
import { readHiddenToken } from "./secret-input.js";
import { renderTerminalQR, terminalQRRowsLeft } from "./qr-terminal.js";
import { agentDependencies, deleteAgent, listAgents, selectAgentAuth, type AgentDependencies } from "./agents.js";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type AgentImageRecipe,
  type ChatCreateParams,
  type ChatSendVoicememoParams,
  type ChatUpdateParams,
  type ContactCardCreateParams,
  type ContactCardUpdateParams,
  type MessageAddReactionParams,
  type MessageContent,
  type MessageCreateParams,
  type MessageSendParams,
  type RelayWebhookEvent,
  type SupportedContentType,
  type WebhookEventType,
  type WebhookSubscriptionUpdateParams,
} from "@relaymessenger/sdk";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import type { ClientContext } from "./client.js";
import { createClientContext } from "./client.js";
import type { ConfigContext, RelayProfile, ResolvedAuth } from "./config.js";
import {
  DEFAULT_API_URL,
  defaultCreationApiURL,
  collectConfiguredTokens,
  configPath,
  localWebhookSecret,
  readConfig,
  resolveAuth,
  validateApiURL,
  validateForwardURL,
  validateProfileName,
  validateToken,
  writeConfig,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { DOCS_LINE, formatRelayHelp, HELP_GROUPS, helpFooter } from "./help-groups.js";
import { AGENT_MODES, CLAUDE_CODE_HINT, DOCS_LLMS_URL, agentDetectedLines, agentMode, docsSection, docsSections, readDocs, resolveDrivingAgent, skillTargets } from "./agent-driver.js";
import { supportedAgentsLine } from "./coding-agents.js";
import { errorText, jsonText, safeMetadata } from "./output.js";
import { listenForAgentEvents } from "./event-listen.js";
import { CliError } from "./error-codes.js";
import { describeFailure } from "./errors.js";
import { EXIT_CODES, exitCodesHelp } from "./exit-codes.js";
import { verboseFetch } from "./verbose.js";
import { relayHelpHeading, writeRelayHelpHeading } from "./relay-brand.js";
import { processPalette } from "./ui-colour.js";

// The shipped version is the manifest's; the release job derives it, so no
// source file may carry its own copy.
const PACKAGE_VERSION: string = createRequire(import.meta.url)("../package.json").version;

export interface ProgramDependencies {
  agents?: AgentDependencies;
  configContext?: ConfigContext;
  resolveClient?: (profile?: string) => Promise<ClientContext>;
  readStdin?: () => Promise<string>;
  readSecret?: () => Promise<string>;
  isInteractive?: boolean;
  prompts?: InteractivePrompts;
  skillPresent?: () => Promise<boolean | "unknown">;
  skillInstaller?: () => Promise<void>;
  cwd?: string;
  confirmDelete?: () => Promise<boolean>;
  confirmLogout?: () => Promise<boolean>;
  /** The one Relay skill offer of a run, made at the end of a connect and
   * nowhere else (owner ruling, 2026-09-09). */
  offerSkill?: () => Promise<void>;
  connect?: Partial<Pick<import("./connect.js").ConnectDependencies, "sniff" | "runCommand" | "startCommand" | "observer" | "bridge" | "renderQR" | "pairTimeoutMs" | "version" | "drivingAgent">>;
  /** Which runtime is driving this command; `@vercel/detect-agent` by default. */
  detectAgent?: () => Promise<import("@vercel/detect-agent").AgentResult>;
  terminalSession?: AgentSessionDependencies["session"];
  terminalIO?: AgentSessionDependencies["io"];
  terminalClient?: AgentSessionDependencies["client"];
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetch?: typeof fetch;
  /** `--json` was asked for, so commander's own usage text stays off the streams. */
  json?: boolean;
  /** Override the process TTY check in focused tests. */
  helpTTY?: boolean;
  /** A pre-rendered root heading, normally supplied only for TTY animation. */
  helpHeading?: string;
}

interface GlobalOptions {
  profile?: string;
  json?: boolean;
  nonInteractive?: boolean;
  agent?: string;
  quiet?: boolean;
  verbose?: boolean;
}

const agentModeValue = (value: string): string => {
  if (!(AGENT_MODES as readonly string[]).includes(value)) throw new InvalidArgumentError("Expected auto, yes or no.");
  return value;
};

// Relay-Server 3097dda, CreateAgentRequest and UpdateContactCardRequest: trim, 1–60.
const aboutText = (value: string): string => {
  const text = value.trim();
  if (!text || [...text].length > 60) throw new InvalidArgumentError("About must be 1 to 60 characters.");
  return text;
};

const integer = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
};

const positiveInteger = (value: string): number => {
  const parsed = integer(value);
  if (parsed < 1) throw new InvalidArgumentError("Expected a positive integer.");
  return parsed;
};

const handle = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("@") || /\s/.test(normalized)) {
    throw new InvalidArgumentError(
      "Handles must be non-empty, contain no spaces, and omit the leading @.",
    );
  }
  return normalized;
};

/**
 * `--to` takes repeated flags, several words after one flag, or one
 * comma-separated list. Commander hands a variadic option's coercion each value
 * with what it kept so far, so the list has to be built here; returning one
 * handle instead leaves a string where the command expects an array.
 */
const recipients = (value: string, previous: string[] = []): string[] =>
  [...previous, ...value.split(",").map(handle)];

const nonempty = (name: string, value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty.`);
  return normalized;
};

const events = (values: string[]): WebhookEventType[] => {
  if (values.length === 0) throw new Error("At least one --event is required.");
  const allowed = new Set<string>(RELAY_WEBHOOK_EVENT_TYPES);
  for (const value of values) {
    if (!allowed.has(value)) throw new Error(`Unknown Relay event type: ${value}`);
  }
  return values as WebhookEventType[];
};

const globals = (command: Command): GlobalOptions =>
  command.optsWithGlobals<GlobalOptions>();

const textContent = (
  text: string,
  idempotencyKey?: string,
  silent?: boolean,
): MessageContent => ({
  parts: [{ type: "text", value: nonempty("Message text", text) }],
  ...(idempotencyKey
    ? { idempotency_key: nonempty("Idempotency key", idempotencyKey) }
    : {}),
  ...(silent ? { silent: true } : {}),
});

async function readImageRecipe(path: string): Promise<AgentImageRecipe> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 8192) throw new Error("Invalid recipe file.");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Recipe too large.");
    const value: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipe must be an object.");
    return value as AgentImageRecipe; // Server's existing recipe parser is authoritative.
  } catch { throw new Error("Image recipe must be a readable JSON object file no larger than 8192 bytes."); }
}

const voidResult = { ok: true };

export const createProgram = (
  dependencies: ProgramDependencies = {},
): Command => {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const configContext: ConfigContext = { ...(dependencies.configContext ?? {}), ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}) };
  const resolveClient = dependencies.resolveClient
    ?? ((profile?: string) => createClientContext(profile, configContext, dependencies.fetch));
  const output = (value: unknown): void => stdout(jsonText(value));
  const clientFor = async (command: Command): Promise<Relay> =>
    (await resolveClient(globals(command).profile)).client;

  // The option rows are the decision page's, in its order. `--version` names
  // the program (GNU 4.8.1: "the canonical name for this program"; gh prints
  // `gh version 2.100.0`, stripe `stripe version 1.50.10`). `--no-input` is
  // clig.dev's name and `--non-interactive` Vercel's, one flag with two
  // spellings so neither is a second row. `--agent` is Supabase's global flag.
  // `-q` and `--verbose` are clig.dev's standard names (ledger rows P21, P36,
  // P53).
  const program = new Command()
    .name("relaymessenger")
    .description("Message the agent on your computer from your phone.")
    .version(`relaymessenger ${PACKAGE_VERSION}`, "-V, --version", "print the version")
    .option("--json", "print the result as JSON, errors included")
    .option("--no-input, --non-interactive", "never ask a question; fail with exit 2 where one is required")
    .option("--agent <auto|yes|no>", "override runtime detection (default auto)", agentModeValue)
    .option("-q, --quiet", "errors only")
    .option("--verbose", "print each request it makes to stderr, as METHOD path status ms")
    .option("--profile <name>", "which saved profile on this computer to use", (configContext.env ?? process.env).RELAY_PROFILE)
    .option("--install-skills", "install the Relay skill for the runtimes on this computer");
  program.exitOverride();
  // A usage error keeps commander's sentence and gains the Docs line; under
  // --json it prints nothing here, because runCLI prints the envelope (MCP's
  // protocol-error class obeys the same format as every other error; ledger
  // rows P05 and P49, captures/relay/exit-usage-badflag-json.txt).
  const usageError = (message: string, write: (value: string) => void): void => {
    if (!dependencies.json) write(`${message.replace(/rly_[A-Za-z0-9_-]+/gu, "[REDACTED]")}${DOCS_LINE}\n`);
  };
  program.configureOutput({
    writeOut: stdout,
    writeErr: stderr,
    outputError: usageError,
  });
  // gh's order: commands before flags, examples first, no wrapping (help-groups.ts).
  program.configureHelp({
    formatHelp: (command, helper) => formatRelayHelp(command, helper, dependencies.helpHeading),
    minWidthToWrap: Number.POSITIVE_INFINITY,
  });
  // Every help screen ends the same way (GNU 4.8.2; gh's LEARN MORE block).
  program.addHelpText("afterAll", (context) => helpFooter(context.command === program));

  const agentDeps = dependencies.agents ?? agentDependencies(configContext, dependencies.fetch);
  const readStdinText = dependencies.readStdin ?? (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  });
  // The live view draws the QR code itself, so a caller that will open it must
  // not print a second copy first (the owner saw two identical codes stacked
  // in the terminal, 2026-09-08).
  const willShowSavedAgent = (command: Command): boolean =>
    !globals(command).json && !globals(command).nonInteractive && dependencies.isInteractive === true
      && (dependencies.terminalSession !== undefined || dependencies.terminalIO !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY));
  const showSavedAgent = async (command: Command, input: AgentSessionInput): Promise<void> => {
    if (!willShowSavedAgent(command)) return;
    try {
      await openSavedAgentSession(input, {
        agents: agentDeps,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.terminalSession ? { session: dependencies.terminalSession } : {}),
        ...(dependencies.terminalIO ? { io: dependencies.terminalIO } : {}),
        ...(dependencies.terminalClient ? { client: dependencies.terminalClient } : {}),
      });
    } catch {
      stderr("Relay could not open the live view for this agent. The agent and its token are unchanged; run the command again to retry.\n");
    }
  };

  // Docker MCP's shape (cmd/docker-mcp/commands/client.go:56-59): the supported
  // list sits inside the usage line, built from the registry so it cannot drift.
  program
    .command("connect")
    .usage(`[options] [agent]\n${supportedAgentsLine()}`)
    .argument("[agent]", "Runtime to connect (see Runs in above)")
    .description("connect a runtime to Relay, new or by token, and wait for its first reply")
    .helpGroup(HELP_GROUPS.getStarted)
    .option("--new", "create a new agent instead of using one you already have")
    .option("--handle <handle>", "the .dev handle you want for a new agent; leave it out and Relay picks one")
    .option("--name <name>", "the name people see next to a new agent")
    .option("--about <text>", "the one line people see above your agent's first message", aboutText)
    .option("--image <path-or-url>", "a picture for a new agent: a file on this computer, or an https:// address")
    .option("--avatar <file>", "a picture for a new agent: a PNG or JPEG on this computer")
    // gh's `auth login --with-token` (ledger row P25): the token comes down a
    // pipe and never touches `ps` or the shell history. `--token` stays for
    // scripts and is the visible one.
    .option("--with-token", "use an agent you already have; its token is read from a pipe")
    .option("--token <token>", "use an agent you already have, by its token; visible in ps and shell history")
    .option("--allow <handles>", "the handles allowed to message this agent, separated by commas; skips sender pairing, not the reply wait")
    .option("-y, --yes", "take the plan as it is")
    .option("--dry-run", "print the plan and change nothing")
    .option("--no-start", "skip the start offer, but still wait for the first reply")
    .option("--no-skill", "do not offer the Relay skill at the end")
    .option("--json", "print the result as JSON")
    .addOption(new Option("--api-url <url>", "the Relay API address to use").argParser(validateApiURL).hideHelp())
    .action(async (agent: string | undefined, options: ConnectRunOptions & { withToken?: boolean }, command: Command) => {
      const env = configContext.env ?? process.env;
      const home = configContext.home ?? homedir();
      const { withToken, ...rest } = options;
      let token = rest.token;
      if (withToken) {
        if (token !== undefined) throw new CliError("Choose --with-token or --token, not both.", "usage");
        token = (await readStdinText()).trim();
        if (!token) throw new CliError("Nothing was piped in. Pipe the token into this command, for example: echo \"$RELAY_AGENT_TOKEN\" | npx relaymessenger connect codex --with-token", "usage");
      }
      await runConnect(agent, {
        ...rest, ...(token === undefined ? {} : { token }),
        json: options.json === true || globals(command).json === true,
        nonInteractive: globals(command).nonInteractive === true || program.getOptionValue("input") === false,
      }, {
        agents: agentDeps,
        env,
        home,
        cwd: dependencies.cwd ?? process.cwd(),
        ...(configContext.platform ? { platform: configContext.platform } : {}),
        ...(globals(command).profile ? { profile: globals(command).profile } : {}),
        stdout,
        stderr,
        ...(dependencies.prompts && dependencies.isInteractive !== false ? { prompts: dependencies.prompts } : {}),
        // Pairing watches the agent's own events; it never answers Relay and
        // never takes an event, so the runtime still receives every message.
        observer: (token, apiURL) => sdkTerminalObserver(new Relay({ apiKey: token, baseURL: apiURL, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) })),
        // Codex, Cursor, Gemini CLI and OpenCode cannot start a turn of their
        // own, so connect stays and answers for them: Codex over its app-server
        // (codex-bridge.ts), the others over ACP (acp-bridge.ts). Control-C ends
        // the wait and the command.
        bridge: async (input) => {
          const control = new AbortController();
          const stop = (): void => control.abort();
          process.once("SIGINT", stop);
          const relayClient = () => new Relay({ apiKey: input.token, baseURL: input.apiURL, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
          try {
            if (input.kind === "acp") {
              await runAcpBridge({
                client: relayClient(),
                acp: await acpCommand(input.command, input.acpArgs ?? [], env),
                cwd: input.cwd,
                // Relay's own tools travel through the agent's session.
                mcpServers: [relayMcpServer(input.mcpServer)],
                label: input.label,
                // The chat's ACP session outlives this run, so a restart picks
                // every chat up where it stopped (acp-threads.ts).
                sessions: await openAcpSessions({ apiURL: input.apiURL, handle: input.handle }, configContext),
                signal: control.signal,
                say: input.say,
              });
            } else {
              await runCodexBridge({
                client: relayClient(),
                codex: await codexCommand(input.command, env),
                cwd: input.cwd,
                // The chat's Codex thread outlives this run, so a restart picks
                // every chat up where it stopped (codex-threads.ts).
                threads: await openCodexThreads({ apiURL: input.apiURL, handle: input.handle }, configContext),
                signal: control.signal,
                say: input.say,
              });
            }
          } finally {
            process.off("SIGINT", stop);
          }
        },
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.offerSkill ? { offerSkill: dependencies.offerSkill } : {}),
        ...dependencies.connect,
      });
    });

  program
    .command("watch")
    .argument("[handle]", "the agent to watch; leave it out for the profile Relay would use")
    .description("see messages arrive and the agent reply, live")
    .helpGroup(HELP_GROUPS.everyDay)
    .action(async (agentHandle: string | undefined, _options: object, command: Command) => {
      const auth = agentHandle === undefined
        ? await resolveAuth(globals(command).profile, configContext)
        : await selectAgentAuth(handle(agentHandle), globals(command).profile, agentDeps);
      if (!willShowSavedAgent(command)) {
        throw new Error("This view needs a terminal. In a script, read events with npx relaymessenger --profile <name> events listen --acknowledge-events instead.");
      }
      await openSavedAgentSession({
        profile: auth.profile, apiURL: auth.apiURL,
        ...(agentHandle ? { handle: handle(agentHandle) } : {}),
      }, {
        agents: agentDeps,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.terminalSession ? { session: dependencies.terminalSession } : {}),
        ...(dependencies.terminalIO ? { io: dependencies.terminalIO } : {}),
        ...(dependencies.terminalClient ? { client: dependencies.terminalClient } : {}),
      });
    });

  program
    .command("listen")
    .description("forward each event to a route on this computer, signed like a webhook, while you develop")
    .helpGroup(HELP_GROUPS.everyDay)
    .requiredOption("--forward-to <url>", "the route on this computer to POST each event to, for example http://localhost:3000/relay-events")
    .action(async (options: { forwardTo: string }, command: Command) => {
      const context = await resolveClient(globals(command).profile);
      await forwardEvents({
        auth: context.auth,
        client: context.client,
        forwardTo: options.forwardTo,
        render: (event) => terminalEventLine(event, [context.auth.token]),
        banner: true,
      });
    });

  program
    .command("doctor")
    .description("check every saved agent and this computer, and say what to fix")
    .helpGroup(HELP_GROUPS.everyDay)
    .option("--offline", "skip the check that calls Relay")
    .action(async (options: { offline?: boolean }, command: Command) => {
      const report = await runDoctor(
        {
          ...(globals(command).profile
            ? { profile: globals(command).profile }
            : {}),
          offline: options.offline ?? false,
        },
        {
          configContext,
          createClient: (resolved) => new Relay({
            apiKey: resolved.token,
            baseURL: resolved.apiURL,
            ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          }),
        },
      );
      output(report);
      if (!report.ok) throw new Error("Some checks did not pass. Each line above says what to fix.");
    });

  const agents = program.command("agents")
    .description("create, list and delete the agents saved on this computer")
    .helpGroup(HELP_GROUPS.everyDay);
  agents.command("create")
    .description("create an agent and save its token privately on this computer, with no account and no sign-in")
    .addOption(new Option("--api-url <url>", "the Relay API address to use").argParser(validateApiURL).hideHelp())
    .option("--token-name <name>", "a label for the new token, so you can tell it apart later")
    .option("--handle <handle>", "the .dev handle you want; leave it out and Relay picks one")
    .option("--name <name>", "the name people see next to this agent")
    .option("--about <text>", "the one line people see above your agent's first message", aboutText)
    .option("--image <path-or-url>", "a picture: a file on this computer, or an https:// address")
    .option("--image-url <url>", "a picture at an https:// address (same as --image with a URL)")
    .option("--image-recipe <json-file>", "a Relay picture recipe file; needs --image or --image-url as well")
    .option("--json", "print the result as JSON")
    .action(async (options: { apiUrl?: string; tokenName?: string; json?: boolean; handle?: string; name?: string; about?: string; image?: string; imageUrl?: string; imageRecipe?: string }, command: Command) => {
      if (options.image !== undefined && options.imageUrl !== undefined) throw new Error("Choose --image or --image-url, not both.");
      const imageRecipe: AgentImageRecipe | undefined = options.imageRecipe === undefined
        ? undefined : await readImageRecipe(options.imageRecipe);
      const created = await createAgentWithPicture({
        ...(program.getOptionValueSource("profile") === "cli" && globals(command).profile ? { profile: globals(command).profile } : {}),
        ...(options.apiUrl ? { apiURL: options.apiUrl } : {}),
        ...(options.tokenName === undefined ? {} : { tokenName: options.tokenName }),
        ...(options.handle === undefined ? {} : { handle: options.handle }),
        ...(options.name === undefined ? {} : { firstName: options.name }),
        ...(options.about === undefined ? {} : { about: options.about }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageUrl === undefined ? {} : { imageURL: options.imageUrl }),
        ...(imageRecipe === undefined ? {} : { imageRecipe }),
        ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
        ...(configContext.home ? { home: configContext.home } : {}),
      }, agentDeps, dependencies.fetch);
      const result = created.result;
      const imageUpdate = created.image;
      if (globals(command).json) output({ ...result, ...(imageUpdate ? { image: imageUpdate } : {}) });
      else {
        stdout(`${result.display_name} (@${result.handle})\nProfile: ${result.profile}\n${result.share_url}\nToken saved in ${configPath(configContext)}\n`);
        const liveViewFollows = imageUpdate?.status !== "incomplete" && willShowSavedAgent(command);
        if (!liveViewFollows) {
          // The QR code holds the public link, never the token. It gets what is
          // left of the window under the four lines printed above it.
          try { stdout(renderTerminalQR(result.share_url, { rows: terminalQRRowsLeft(process.stdout.rows, 5) })); }
          catch { stderr("Relay could not draw the QR code. Use the link above instead.\n"); }
        }
        if (imageUpdate?.status === "incomplete") output({ image: imageUpdate });
      }
      if (imageUpdate?.status !== "incomplete") {
        await showSavedAgent(command, {
          profile: result.profile, handle: result.handle, apiURL: result.api_url, shareURL: result.share_url,
          runtime: { ownership: "none", connection: "not-started" },
        });
      }
      if (imageUpdate?.status === "incomplete") {
        throw new Error(incompletePictureMessage(result.handle, result.profile, imageUpdate, imageRecipe !== undefined));
      }
    });
  agents.command("list")
    .description("list the agents saved on this computer, each read with its own token")
    .option("--json", "print the result as JSON")
    .action(async () => {
      let firstFailure: Error | undefined;
      const result = await listAgents(agentDeps, (error) => { firstFailure ??= error; });
      output(result);
      // Keep successful entries on stdout; the first failed entry determines
      // the standard stderr envelope and classified command exit.
      if (firstFailure) throw firstFailure;
    });
  agents.command("delete").argument("<handle>", "agent handle", handle)
    .description("delete an agent at Relay, then remove its saved token from this computer")
    .option("--json", "print the result as JSON")
    .action(async (agentHandle: string, _options: object, command: Command) => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmDelete && !await dependencies.confirmDelete()) throw new InteractiveCancelled();
      output(await deleteAgent(agentHandle, globals(command).profile, agentDeps));
    });

  const authCommands = program.command("auth", { hidden: true }).description("save, check and remove the token this computer signs in with").helpGroup(HELP_GROUPS.everythingElse);
  authCommands.configureOutput({
    outputError: usageError,
  });
  const authLogin = async (
    options: { withToken?: boolean; apiUrl?: string },
    command: Command,
  ): Promise<void> => {
      const env = configContext.env ?? process.env;
      const config = await readConfig(configContext);
      const profile = validateProfileName(globals(command).profile ?? config.current_profile);
      const previous = config.profiles[profile] ?? {};
      let raw: string | undefined;
      if (options.withToken && !dependencies.readStdin && process.stdin.isTTY) {
        if (globals(command).nonInteractive || globals(command).json || dependencies.isInteractive === false) throw new CliError("Nothing is piped in. Pipe the token into this command, for example: echo \"$RELAY_AGENT_TOKEN\" | npx relaymessenger auth login --with-token", "not_a_tty");
        raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
      } else if (options.withToken) {
        raw = await readStdinText();
      } else if (env.RELAY_AGENT_TOKEN !== undefined) raw = env.RELAY_AGENT_TOKEN;
      else {
        const interactive = !globals(command).nonInteractive && !globals(command).json && (dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY));
        if (!interactive) throw new CliError("Relay has no token and cannot ask for one here. Pipe it into npx relaymessenger auth login --with-token, or set RELAY_AGENT_TOKEN.", "not_a_tty");
        raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
      }
      if (!raw) throw new Error("No token was given, so nothing was changed.");
      const token = validateToken(raw);
      const apiURL = validateApiURL(options.apiUrl ?? env.RELAY_API_URL ?? previous.api_url ?? defaultCreationApiURL());
      {
        try {
          const cards = await agentDeps.client(token, apiURL).contactCard.retrieve();
          if (cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active).length !== 1) throw new Error("This token must belong to exactly one active agent.");
        } catch { throw new Error("Relay would not accept this token. Nothing was changed: your saved token is as it was."); }
      }
      config.profiles[profile] = { api_url: apiURL, agent_token: token };
      await writeConfig(config, configContext);
      output(safeMetadata({ ok: true, profile, api_url: apiURL, token: "stored" }, [token]));
      await showSavedAgent(command, { profile, apiURL, runtime: { ownership: "unknown", connection: "unknown" } });
  };
  const authStatus = async (_options: object, command: Command): Promise<void> => {
      const resolved = await resolveAuth(globals(command).profile, configContext);
      output({
        configured: true,
        profile: resolved.profile,
        api_url: resolved.apiURL,
        token_source: resolved.tokenSource,
        config_path: resolved.configPath,
      });
      const saved = (await agentDeps.read()).profiles[resolved.profile];
      if (saved?.agent_token === resolved.token && validateApiURL(saved.api_url ?? DEFAULT_API_URL) === resolved.apiURL) {
        await showSavedAgent(command, { profile: resolved.profile, apiURL: resolved.apiURL });
      }
  };
  const authLogout = async (_options: object, command: Command): Promise<void> => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmLogout && !await dependencies.confirmLogout()) throw new InteractiveCancelled();
      const config = await readConfig(configContext);
      const profile = validateProfileName(
        globals(command).profile ?? config.current_profile,
      );
      const selected = config.profiles[profile];
      if (!selected) throw new CliError(`Relay profile ${profile} does not exist.`, "not_found");
      // clig.dev, Output: "If you change state, tell the user" — and only when
      // it changed. With nothing saved there is nothing to remove, so the
      // file is left alone and the answer says so (ledger row P14).
      if (selected.agent_token === undefined) {
        output({ ok: true, profile, token: "none" });
        if (!globals(command).json && !globals(command).quiet) stderr(`No token was saved for profile ${profile}.\n`);
        return;
      }
      const { agent_token: _removed, ...withoutToken } = selected;
      config.profiles[profile] = withoutToken;
      await writeConfig(config, configContext);
      output({ ok: true, profile, token: "removed" });
  };
  const addAuthLogin = (command: Command): void => {
    command
      .option("--with-token", "read the token from a pipe instead of asking for it")
      .addOption(new Option("--api-url <url>", "the Relay API address this profile uses").hideHelp())
      .action(authLogin);
  };
  const addAuthStatus = (command: Command): void => {
    command.action(authStatus);
  };
  const addAuthLogout = (command: Command): void => {
    command.action(authLogout);
  };
  const authLoginCommand = authCommands.command("login")
    .description("save a token for this computer, from a hidden prompt, a pipe, or RELAY_AGENT_TOKEN");
  addAuthLogin(authLoginCommand);
  const authStatusCommand = authCommands.command("status")
    .description("show which token Relay would use, and where it comes from, without printing it");
  addAuthStatus(authStatusCommand);
  const authLogoutCommand = authCommands.command("logout")
    .description("remove the selected profile's stored token");
  addAuthLogout(authLogoutCommand);

  // Linq-style top-level names; the hidden `auth` tree remains compatible with
  // existing scripts and is still the canonical implementation underneath.
  const loginCommand = program.command("login")
    .description("authenticate with a Relay agent token")
    .helpGroup(HELP_GROUPS.everythingElse);
  addAuthLogin(loginCommand);
  const whoamiCommand = program.command("whoami")
    .description("show the current Relay identity without printing its token")
    .helpGroup(HELP_GROUPS.everythingElse);
  addAuthStatus(whoamiCommand);
  const logoutCommand = program.command("logout")
    .description("remove the saved Relay agent token from this computer")
    .helpGroup(HELP_GROUPS.everythingElse);
  addAuthLogout(logoutCommand);

  const profiles = program.command("profiles", { hidden: true }).description("manage the saved profiles on this computer: add, choose, remove and list them").helpGroup(HELP_GROUPS.everythingElse);
  profiles
    .command("add")
    .argument("<name>", "profile name", validateProfileName)
    .addOption(new Option("--api-url <url>", "the Relay API address this profile uses")
      .argParser(validateApiURL).makeOptionMandatory().hideHelp())
    .description("add a profile without storing a token")
    .action(async (name: string, options: { apiUrl: string }) => {
      const config = await readConfig(configContext);
      if (config.profiles[name]) throw new Error(`Relay profile ${name} already exists.`);
      config.profiles[name] = { api_url: options.apiUrl };
      await writeConfig(config, configContext);
      output({ ok: true, profile: name, api_url: options.apiUrl });
    });
  profiles
    .command("use")
    .argument("<name>", "profile name", validateProfileName)
    .description("select the default local profile")
    .action(async (name: string) => {
      const config = await readConfig(configContext);
      if (!config.profiles[name]) throw new CliError(`Relay profile ${name} does not exist.`, "not_found");
      config.current_profile = name;
      await writeConfig(config, configContext);
      output({ ok: true, current_profile: name });
    });
  profiles
    .command("remove")
    .argument("<name>", "profile name", validateProfileName)
    .description("remove a non-current profile and its token")
    .action(async (name: string) => {
      const config = await readConfig(configContext);
      if (name === config.current_profile) {
        throw new Error("Cannot remove the current profile; select another first.");
      }
      if (!config.profiles[name]) throw new CliError(`Relay profile ${name} does not exist.`, "not_found");
      delete config.profiles[name];
      await writeConfig(config, configContext);
      output({ ok: true, removed: name });
    });
  profiles
    .command("list")
    .description("list profiles without revealing tokens")
    .action(async () => {
      const config = await readConfig(configContext);
      output({
        current_profile: config.current_profile,
        profiles: Object.entries(config.profiles).map(([name, profile]) => ({
          name,
          current: name === config.current_profile,
          api_url: profile.api_url ?? DEFAULT_API_URL,
          has_token: Boolean(profile.agent_token),
        })),
      });
    });

  program
    .command("docs", { hidden: true })
    .argument("[section]", "print one section of the documentation, by the name docs --list shows")
    .option("--list", "print the section names, one per line")
    .description("print Relay's documentation for agents, or the address to read it at")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(async (section: string | undefined, options: { list?: boolean }, command: Command) => {
      const fetchDocs = () => readDocs(dependencies.fetch ?? globalThis.fetch);
      // Anthropic's pagination rule for a response that could fill the context
      // (ledger rows P45, P47): the names, or one section, on request.
      if (options.list || section !== undefined) {
        const text = await fetchDocs();
        if (text === undefined) throw new CliError(`Relay's documentation could not be read from ${DOCS_LLMS_URL}.`, "network");
        if (options.list) {
          const names = docsSections(text);
          if (globals(command).json) output({ sections: names });
          else stdout(`${names.join("\n")}\n`);
          return;
        }
        const chosen = docsSection(text, section!);
        if (chosen === undefined) throw new CliError(`There is no documentation section named ${section}. Run npx relaymessenger docs --list to see the names.`, "not_found");
        if (globals(command).json) output({ section, text: chosen });
        else stdout(chosen);
        return;
      }
      // A person gets the address to open. An agent, which has no terminal, gets
      // the text itself in one request, the way Railway prints its llms.txt.
      const headless = dependencies.isInteractive === false
        || (dependencies.isInteractive === undefined && !process.stdout.isTTY);
      if (globals(command).json) { output({ url: DOCS_LLMS_URL }); return; }
      const text = headless ? await fetchDocs() : undefined;
      stdout(text ?? `${DOCS_LLMS_URL}\n`);
    });

  program
    .command("config-path", { hidden: true })
    .description("print where Relay keeps its config file on this computer")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(() => output({ path: configPath(configContext) }));

  const chats = program.command("chats", { hidden: true }).helpGroup(HELP_GROUPS.everythingElse)
    .description("read and update chats");
  chats.addHelpText("after",
    "\nTo start or join a chat that includes a person, every agent in it must already be one of that person's contacts and not blocked. "
    + "Chats between agents only need no such contact.\n");
  chats
    .command("list")
    .description("list the chats this agent is in, a page at a time")
    .option("--cursor <cursor>", "continue from the cursor returned by the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .action(async (
      options: { cursor?: string; limit?: number },
      command: Command,
    ) => {
      const page = await (await clientFor(command)).chats.listChats(options);
      output({ chats: page.chats, next_cursor: page.nextCursor });
    });
  chats
    .command("get")
    .description("show one chat")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.retrieve(chatID)));
  chats
    .command("create")
    .description("create a Chat with at most 7 total participants, including the sender")
    .requiredOption("--from <handle>", "sender Handle", handle)
    .requiredOption("--to <handles...>", "at most 6 recipient Handles; repeat --to or use a comma-separated list", recipients)
    .requiredOption("--text <text>", "the text to send")
    .requiredOption("--idempotency-key <key>", "reuse this key to avoid sending the same request twice")
    .action(async (
      options: { from: string; to: string[]; text: string; idempotencyKey: string },
      command: Command,
    ) => {
      if (options.to.length > 6) throw new Error("A Chat accepts at most 6 recipient Handles (7 total participants).");
      const body = {
        from: options.from,
        to: options.to,
        message: textContent(options.text, options.idempotencyKey),
      } satisfies ChatCreateParams;
      output(await (await clientFor(command)).chats.create(body));
    });
  chats
    .command("update")
    .description("rename a group chat, or set or clear its picture")
    .argument("<chat-id>", "the chat ID")
    .option("--display-name <name>", "the name people see for this chat")
    .option("--group-icon <attachment-id-or-https-url>", "the picture for this chat")
    .option("--clear-group-icon", "remove the picture from this chat")
    .action(async (
      chatID: string,
      options: {
        displayName?: string;
        groupIcon?: string;
        clearGroupIcon?: boolean;
      },
      command: Command,
    ) => {
      if (options.groupIcon && options.clearGroupIcon) {
        throw new Error("Choose --group-icon or --clear-group-icon, not both.");
      }
      const body = {
        ...(options.displayName === undefined
          ? {}
          : { display_name: nonempty("Display name", options.displayName) }),
        ...(options.groupIcon
          ? { group_chat_icon: options.groupIcon }
          : options.clearGroupIcon
          ? { group_chat_icon: null }
          : {}),
      } satisfies ChatUpdateParams;
      if (Object.keys(body).length === 0) throw new Error("Nothing to change. Pass --display-name, --group-icon or --clear-group-icon.");
      output(await (await clientFor(command)).chats.update(chatID, body));
    });
  chats
    .command("leave")
    .description("leave a chat; it stays for everyone else")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.leaveChat(chatID)));
  chats
    .command("read")
    .description("mark everything in a chat as read")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.markAsRead(chatID);
      output(voidResult);
    });

  const typing = chats.command("typing").description("manage Chat typing state");
  typing
    .command("start")
    .description("show that this agent is typing in a chat")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.startTyping(chatID);
      output(voidResult);
    });
  typing
    .command("stop")
    .description("stop showing that this agent is typing")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.stopTyping(chatID);
      output(voidResult);
    });

  const participants = chats.command("participants")
    .description("add or remove agents in a chat");
  participants.addHelpText("after",
    "\nIn a chat that includes a person, the agent you add and the agent doing the adding must both be that person's contacts and not blocked. "
    + "The same holds for an agent that removes another. An agent may always leave a chat itself.\n");
  participants
    .command("add")
    .description("add an agent to a chat")
    .argument("<chat-id>", "the chat ID")
    .argument("<handle>", "participant Handle", handle)
    .option("--hide-history", "the new agent sees only messages sent after it joins (this is what Relay does by default)")
    .option("--no-hide-history", "the new agent can also read the messages sent before it joined")
    .action(async (
      chatID: string,
      participantHandle: string,
      options: { hideHistory?: boolean },
      command: Command,
    ) => output(
      await (await clientFor(command)).chats.participants.add(
        chatID,
        {
          handle: participantHandle,
          ...(options.hideHistory === undefined ? {} : { hide_history: options.hideHistory }),
        },
      ),
    ));
  participants
    .command("remove")
    .description("remove an agent from a chat")
    .argument("<chat-id>", "the chat ID")
    .argument("<handle>", "participant Handle", handle)
    .action(async (
      chatID: string,
      participantHandle: string,
      _options: object,
      command: Command,
    ) => output(
      await (await clientFor(command)).chats.participants.remove(
        chatID,
        { handle: participantHandle },
      ),
    ));

  const chatMessages = chats.command("messages").description("read and send Chat Messages");
  chatMessages
    .command("list")
    .description("list the messages in a chat, a page at a time")
    .argument("<chat-id>", "the chat ID")
    .option("--cursor <cursor>", "continue from the cursor returned by the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .option("--order <order>", "asc (default, oldest first) or desc (newest first)")
    .action(async (
      chatID: string,
      options: { cursor?: string; limit?: number; order?: string },
      command: Command,
    ) => {
      if (options.order && options.order !== "asc" && options.order !== "desc") {
        throw new Error("--order must be asc or desc.");
      }
      const page = await (await clientFor(command)).chats.messages.list(
        chatID,
        {
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.order
            ? { order: options.order as "asc" | "desc" }
            : {}),
        },
      );
      output({ messages: page.messages, next_cursor: page.nextCursor });
    });
  chatMessages
    .command("send")
    .description("send a text message to a chat")
    .argument("<chat-id>", "the chat ID")
    .requiredOption("--text <text>", "the text to send")
    .requiredOption("--idempotency-key <key>", "reuse this key to avoid sending the same request twice")
    .option("--silent", "deliver without a banner or sound")
    .action(async (
      chatID: string,
      options: { text: string; idempotencyKey: string; silent?: boolean },
      command: Command,
    ) => {
      const body = {
        message: textContent(options.text, options.idempotencyKey, options.silent),
      } satisfies MessageSendParams;
      output(await (await clientFor(command)).chats.messages.send(chatID, body));
    });

  chats
    .command("voice-memo")
    .description("send a voice memo to a chat, by attachment or by address")
    .argument("<chat-id>", "the chat ID")
    .option("--attachment-id <id>", "the completed attachment to send")
    .option("--url <url>", "the address of the audio to send")
    .action(async (
      chatID: string,
      options: { attachmentId?: string; url?: string },
      command: Command,
    ) => {
      if (Boolean(options.attachmentId) === Boolean(options.url)) {
        throw new Error("Choose exactly one of --attachment-id or --url.");
      }
      const body = options.attachmentId
        ? { attachment_id: options.attachmentId }
        : { voice_memo_url: options.url! };
      output(
        await (await clientFor(command)).chats.sendVoicememo(
          chatID,
          body satisfies ChatSendVoicememoParams,
        ),
      );
    });

  const messages = program.command("messages", { hidden: true }).description("read, send, and react to Messages").helpGroup(HELP_GROUPS.everythingElse);
  messages
    .command("send")
    .description("start or reuse a chat with the handles you name, and send one message")
    .requiredOption("--to <handles...>", "at most 6 recipient Handles; repeat --to or use a comma-separated list", recipients)
    .requiredOption("--text <text>", "the text to send")
    .requiredOption("--idempotency-key <key>", "reuse this key to avoid sending the same request twice")
    .option("--silent", "deliver without a banner or sound")
    .action(async (
      options: { to: string[]; text: string; idempotencyKey: string; silent?: boolean },
      command: Command,
    ) => {
      if (options.to.length > 6) throw new Error("A Chat accepts at most 6 recipient Handles (7 total participants).");
      const body = {
        to: options.to,
        message: textContent(options.text, options.idempotencyKey, options.silent),
      } satisfies MessageCreateParams;
      output(await (await clientFor(command)).messages.create(body));
    });
  messages
    .command("get")
    .description("show one message")
    .argument("<message-id>", "the message ID")
    .action(async (messageID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).messages.retrieve(messageID)));
  messages
    .command("thread")
    .description("list the replies to a message, a page at a time")
    .argument("<message-id>", "the message ID")
    .option("--cursor <cursor>", "continue from the cursor returned by the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .option("--order <order>", "asc or desc")
    .action(async (
      messageID: string,
      options: { cursor?: string; limit?: number; order?: string },
      command: Command,
    ) => {
      if (options.order && options.order !== "asc" && options.order !== "desc") {
        throw new Error("--order must be asc or desc.");
      }
      const page = await (await clientFor(command)).messages.listMessagesThread(
        messageID,
        {
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.order
            ? { order: options.order as "asc" | "desc" }
            : {}),
        },
      );
      output({ messages: page.messages, next_cursor: page.nextCursor });
    });
  messages
    .command("react")
    .description("add or remove a reaction on a message")
    .argument("<message-id>", "the message ID")
    .requiredOption("--operation <operation>", "add or remove")
    .requiredOption("--type <type>", "the reaction type to use")
    .option("--custom-emoji <emoji>", "the emoji to use for a custom reaction")
    .option("--part-index <number>", "which part of the message to react to, counting from 0", integer)
    .action(async (
      messageID: string,
      options: {
        operation: string;
        type: string;
        customEmoji?: string;
        partIndex?: number;
      },
      command: Command,
    ) => {
      const operations = new Set(["add", "remove"]);
      const types = new Set([
        "love",
        "like",
        "dislike",
        "laugh",
        "emphasize",
        "question",
        "custom",
      ]);
      if (!operations.has(options.operation)) throw new Error("--operation must be add or remove.");
      if (!types.has(options.type)) throw new Error("--type must be one of: love, like, dislike, laugh, emphasize, question, custom.");
      if (options.type === "custom" && !options.customEmoji) {
        throw new Error("--custom-emoji is required for a custom reaction.");
      }
      if (options.type !== "custom" && options.customEmoji) {
        throw new Error("--custom-emoji is valid only for a custom reaction.");
      }
      const body = {
        operation: options.operation as "add" | "remove",
        type: options.type as MessageAddReactionParams["type"],
        ...(options.customEmoji ? { custom_emoji: options.customEmoji } : {}),
        ...(options.partIndex === undefined ? {} : { part_index: options.partIndex }),
      } satisfies MessageAddReactionParams;
      output(await (await clientFor(command)).messages.addReaction(messageID, body));
    });

  const attachments = program.command("attachments", { hidden: true }).description("upload files to Relay, and read or delete the ones you uploaded").helpGroup(HELP_GROUPS.everythingElse);
  attachments
    .command("allocate")
    .description("reserve a place for a file at Relay, and get the address to upload it to")
    .requiredOption("--filename <name>", "the name of the uploaded file")
    .requiredOption("--content-type <type>", "the MIME type of the file")
    .requiredOption("--size <bytes>", "file size", positiveInteger)
    .action(async (
      options: { filename: string; contentType: string; size: number },
      command: Command,
    ) => output(await (await clientFor(command)).attachments.create({
      filename: nonempty("Filename", options.filename),
      content_type: nonempty(
        "Content type",
        options.contentType,
      ) as SupportedContentType,
      size_bytes: options.size,
    })));
  attachments
    .command("upload")
    .description("upload a file from this computer in one step")
    .argument("<file>", "the file to upload")
    .requiredOption("--content-type <type>", "the MIME type of the file")
    .action(async (
      file: string,
      options: { contentType: string },
      command: Command,
    ) => {
      const client = await clientFor(command);
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new Error("Attachment path is not a file.");
      const allocation = await client.attachments.create({
        filename: file.split(/[\\/]/).pop() ?? "attachment",
        content_type: nonempty(
          "Content type",
          options.contentType,
        ) as SupportedContentType,
        size_bytes: metadata.size,
      });
      await client.attachments.upload(allocation, await readFile(file));
      output(allocation);
    });
  attachments
    .command("get")
    .description("show one file this agent uploaded")
    .argument("<attachment-id>", "the attachment ID")
    .action(async (attachmentID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).attachments.retrieve(attachmentID)));
  attachments
    .command("delete")
    .description("delete a file this agent uploaded")
    .argument("<attachment-id>", "the attachment ID")
    .action(async (attachmentID: string, _options: object, command: Command) => {
      await (await clientFor(command)).attachments.delete(attachmentID);
      output(voidResult);
    });

  const blocked = program.command("blocked-handles", { hidden: true }).description("block a handle from reaching this agent, unblock one, or list them").helpGroup(HELP_GROUPS.everythingElse);
  blocked
    .command("list")
    .description("list the handles this agent has blocked")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).blockedHandles.list()));
  blocked
    .command("add")
    .description("block a handle, so it can no longer reach this agent")
    .argument("<handle>", "Handle", handle)
    .option("--reason <reason>", "a note explaining why this handle is blocked")
    .action(async (
      blockedHandle: string,
      options: { reason?: string },
      command: Command,
    ) => output(await (await clientFor(command)).blockedHandles.block({
      handle: blockedHandle,
      ...(options.reason ? { reason: options.reason } : {}),
    })));
  blocked
    .command("remove")
    .description("unblock a handle")
    .argument("<handle>", "Handle", handle)
    .action(async (
      blockedHandle: string,
      _options: object,
      command: Command,
    ) => {
      await (await clientFor(command)).blockedHandles.unblock({
        handle: blockedHandle,
      });
      output(voidResult);
    });

  const webhooks = program.command("webhooks", { hidden: true }).description("list the event types Relay can send, and manage where it sends them").helpGroup(HELP_GROUPS.everythingElse);
  webhooks
    .command("events")
    .description("list every event type Relay can send, and where each is documented")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookEvents.list()));
  // `listen` is the local half of the two ways to run an agent backend, the
  // way Stripe's `stripe listen --forward-to localhost:4242/webhook` is: each
  // event is POSTed to a route on this computer, signed exactly like a
  // deployed webhook, so the same handler runs unchanged in both places.
  const forwardEvents = async (input: {
    auth: ResolvedAuth;
    client: Relay;
    forwardTo?: string;
    render?: (event: RelayWebhookEvent) => string;
    banner: boolean;
  }): Promise<void> => {
    const forwardTo = input.forwardTo ? validateForwardURL(input.forwardTo) : undefined;
    const secret = forwardTo ? await localWebhookSecret(input.auth.profile, configContext) : undefined;
    if (input.banner && forwardTo && secret) {
      stderr(`Forwarding events to ${link(forwardTo)}\n`);
      stderr(`Local signing secret  ${secret}   ${dim("(set RELAY_WEBHOOK_SECRET to it while you develop)")}\n`);
      stderr(`${dim("Events read here count as delivered; a deployed webhook for this agent does not get them.")}\n`);
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await listenForAgentEvents(
        input.client,
        {
          ...(forwardTo && secret ? { forwardTo, secret } : {}),
          ...(input.render ? { render: input.render } : {}),
          signal: controller.signal,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        },
        { stdout, stderr },
      );
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  };

  // `watch` is the live view a person means. `events listen` is a different
  // thing wearing a similar name: it takes events, so Relay can stop resending
  // them elsewhere. It keeps its flags and its behaviour, and leaves the help.
  program
    .command("events", { hidden: true })
    .description("the older name for watching events; it takes events, so prefer watch")
    .helpGroup(HELP_GROUPS.unlisted)
    .command("listen")
    .option("--forward-to <url>", "also POST each event to this address on your own computer (localhost only), signed like a webhook")
    .requiredOption(
      "--acknowledge-events",
      "yes: this agent is a test agent, and reading events here may make Relay stop resending them elsewhere",
    )
    .description("print each event as it arrives, and optionally send a signed copy to your own computer")
    .action(async (
      options: { forwardTo?: string; acknowledgeEvents: boolean },
      command: Command,
    ) => {
      const requestedProfile = globals(command).profile;
      if (!requestedProfile) {
        throw new Error(
          "Name the test agent to watch with --profile. This command will not guess.",
        );
      }
      const context = await resolveClient(requestedProfile);
      if (context.auth.apiURL === DEFAULT_API_URL) {
        throw new Error(
          "This command only works against a test Relay API, never the live one. Use a profile pointed at staging.",
        );
      }
      await forwardEvents({
        auth: context.auth,
        client: context.client,
        ...(options.forwardTo ? { forwardTo: options.forwardTo } : {}),
        banner: false,
      });
    });

  const subscriptions = webhooks.command("subscriptions").description("manage webhook subscriptions");
  subscriptions
    .command("list")
    .description("list the addresses Relay sends this agent's events to")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookSubscriptions.list()));
  subscriptions
    .command("get")
    .description("show one address Relay sends events to")
    .argument("<subscription-id>", "the webhook subscription ID")
    .action(async (subscriptionID: string, _options: object, command: Command) =>
      output(
        await (await clientFor(command)).webhookSubscriptions.retrieve(
          subscriptionID,
        ),
      ));
  subscriptions
    .command("create")
    .description("tell Relay to send the events you choose to an address you own")
    .requiredOption("--target-url <url>", "the address that receives webhook events")
    .requiredOption("--event <events...>", "the event types this subscription receives")
    .action(async (
      options: { targetUrl: string; event: string[] },
      command: Command,
    ) => output(
      await (await clientFor(command)).webhookSubscriptions.create({
        target_url: options.targetUrl,
        subscribed_events: events(options.event),
      }),
    ));
  subscriptions
    .command("update")
    .description("change the address, the events, or whether Relay sends to it at all")
    .argument("<subscription-id>", "the webhook subscription ID")
    .option("--target-url <url>", "the address that receives webhook events")
    .option("--event <events...>", "the event types this subscription receives")
    .option("--active", "enable delivery to this subscription")
    .option("--inactive", "disable delivery to this subscription")
    .action(async (
      subscriptionID: string,
      options: {
        targetUrl?: string;
        event?: string[];
        active?: boolean;
        inactive?: boolean;
      },
      command: Command,
    ) => {
      if (options.active && options.inactive) {
        throw new Error("Choose --active or --inactive, not both.");
      }
      const body = {
        ...(options.targetUrl ? { target_url: options.targetUrl } : {}),
        ...(options.event ? { subscribed_events: events(options.event) } : {}),
        ...(options.active
          ? { is_active: true }
          : options.inactive
          ? { is_active: false }
          : {}),
      } satisfies WebhookSubscriptionUpdateParams;
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to change. Pass --target-url, --event, --active or --inactive.");
      }
      output(
        await (await clientFor(command)).webhookSubscriptions.update(
          subscriptionID,
          body,
        ),
      );
    });
  subscriptions
    .command("delete")
    .description("stop Relay sending events to that address")
    .argument("<subscription-id>", "the webhook subscription ID")
    .action(async (subscriptionID: string, _options: object, command: Command) => {
      await (await clientFor(command)).webhookSubscriptions.delete(subscriptionID);
      output(voidResult);
    });

  const contactCard = program.command("contact-card", { hidden: true }).description("set the name and picture people see for this agent, and share it into a chat").helpGroup(HELP_GROUPS.everythingElse);
  contactCard
    .command("get")
    .description("show the name and picture people see for this agent")
    .option("--handle <handle>", "the agent's handle", handle)
    .action(async (options: { handle?: string }, command: Command) =>
      output(await (await clientFor(command)).contactCard.retrieve(options)));
  contactCard
    .command("setup")
    .description("set the name and picture people see for this agent, the first time")
    .requiredOption("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the name people see next to this agent")
    .addOption(new Option("--first-name <name>", "the name people see next to this agent").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--image-url <url>", "a picture at an https:// address")
    .action(async (
      options: {
        handle: string;
        name?: string; about?: string;
        firstName?: string;
        lastName?: string;
        imageUrl?: string;
      },
      command: Command,
    ) => {
      const body = {
        handle: options.handle,
        first_name: nonempty("Name", options.name ?? options.firstName ?? ""),
        ...(options.lastName ? { last_name: options.lastName } : {}),
        ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
      } satisfies ContactCardCreateParams;
      output(await (await clientFor(command)).contactCard.create(body));
    });
  contactCard
    .command("update")
    .alias("set")
    .description("change the name or picture people see for this agent")
    .requiredOption("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the name people see next to this agent")
    .option("--about <text>", "the one line people see above your agent's first message", aboutText)
    .addOption(new Option("--first-name <name>", "the name people see next to this agent").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--clear-last-name", "remove the second name")
    .option("--image <path-or-url>", "a picture: a file on this computer, or an https:// address")
    .option("--image-url <url>", "a picture at an https:// address")
    .option("--attachment-id <id>", "finish setting a picture you already uploaded")
    .option("--image-recipe <json-file>", "a Relay picture recipe file to go with the picture")
    .option("--clear-image-url", "remove the picture")
    .action(async (
      options: {
        handle: string;
        name?: string; about?: string;
        firstName?: string;
        lastName?: string;
        clearLastName?: boolean;
        image?: string;
        imageUrl?: string;
        attachmentId?: string;
        imageRecipe?: string;
        clearImageUrl?: boolean;
      },
      command: Command,
    ) => {
      if (options.lastName && options.clearLastName) {
        throw new Error("Choose --last-name or --clear-last-name, not both.");
      }
      if ([options.image, options.imageUrl, options.attachmentId, options.clearImageUrl || undefined].filter((value) => value !== undefined).length > 1) throw new Error("Choose one image input or --clear-image-url.");
      const image = options.image === undefined ? undefined : await prepareAgentImage(options.image, {
        ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}), ...(configContext.home ? { home: configContext.home } : {}),
      });
      const imageURL = image?.kind === "url" ? image.url : options.imageUrl;
      if (options.imageRecipe && !image && !options.imageUrl && !options.attachmentId) throw new Error("--image-recipe requires a rendered image URL, file, or completed attachment.");
      const recipe = options.imageRecipe ? await readImageRecipe(options.imageRecipe) : undefined;
      const body = {
        handle: options.handle,
        ...(options.about === undefined ? {} : { about: options.about }),
        ...((options.name ?? options.firstName) ? { first_name: (options.name ?? options.firstName)! } : {}),
        ...(options.lastName
          ? { last_name: options.lastName }
          : options.clearLastName
          ? { last_name: null }
          : {}),
        ...(imageURL
          ? { image_url: imageURL }
          : options.clearImageUrl
          ? { image_url: null }
          : {}),
        ...(recipe ? { image_recipe: recipe } : {}),
      } satisfies ContactCardUpdateParams;
      if (image?.kind === "file" || options.attachmentId) {
        const selected = await resolveClient(globals(command).profile);
        const client = selected.client;
        const rawOutcome = await uploadAgentImage({ handle: options.handle,
          ...(image?.kind === "file" ? { image: image.file } : {}), ...(options.attachmentId ? { attachmentID: options.attachmentId } : {}),
        }, client, (attachmentID) => client.contactCard.update({ ...body, attachment_id: attachmentID }, { maxRetries: 0 }));
        const outcome = safeMetadata(rawOutcome, [selected.auth.token]);
        if (outcome.status === "updated") output(outcome.agent);
        else { output({ image: outcome }); throw new Error("The picture did not go through. Keep this profile and run this same update again; do not create another agent."); }
        return;
      }
      if (Object.keys(body).length === 1) {
        throw new Error("Nothing to change. Pass --name, --last-name, a picture option, or one of the --clear options.");
      }
      output(await (await clientFor(command)).contactCard.update(body));
    });
  contactCard
    .command("share")
    .description("share this agent's name and picture into a chat")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.shareContactCard(chatID);
      output(voidResult);
    });

  // gh's `gh help exit-codes` (ledger row P40): a help topic, reachable as
  // `help exit-codes`, `exit-codes` and `exit-codes --help`, each printing the
  // same table and nothing else. Named nowhere in the listings.
  program
    .command("exit-codes", { hidden: true })
    .description("the exit codes this command uses, and what each one means")
    .helpGroup(HELP_GROUPS.unlisted)
    .configureHelp({ formatHelp: () => `${exitCodesHelp()}\n` })
    .action(() => stdout(exitCodesHelp()));

  // Last, so only the root's own help command takes this group: set earlier, the
  // default would be inherited by every subcommand and put an "Everything else"
  // heading on ten help screens that have no such section.
  program.commandsGroup(HELP_GROUPS.everythingElse)
    .helpCommand("help [command]", "show what a command does and the options it takes");

  return program;
};

export const runCLI = async (
  argv: string[],
  dependencies: ProgramDependencies = {},
): Promise<number> => {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const env = dependencies.configContext?.env ?? process.env;
  const json = argv.includes("--json");
  // `-q` keeps stderr for errors alone: the agent line, the plugin hint, the
  // cancel note and the skill offer all stay silent (clig.dev, standard names).
  const quiet = argv.includes("-q") || argv.includes("--quiet");
  const note = quiet ? (): void => undefined : stderr;
  if (argv.includes("--verbose")) {
    dependencies = { ...dependencies, fetch: verboseFetch(dependencies.fetch ?? globalThis.fetch, stderr) };
  }
  // An agent driving this command gets no questions, the way Vercel's CLI turns
  // itself non-interactive when its detector says so, and `--agent` overrides
  // the detector either way (Supabase). Inside Claude Code the plugin hint goes
  // to stderr first, as Vercel's and Supabase's CLIs do; every agent then gets
  // the one "Agent detected" line and the docs address. All of it is held back
  // under --json so that stream stays one JSON document.
  // The detector reads the process environment; a caller that injects its own
  // environment injects its own detector too, or is taken to be no agent.
  const driver = await resolveDrivingAgent(agentMode(argv), dependencies.detectAgent ?? (dependencies.configContext?.env ? async () => ({ isAgent: false, agent: undefined }) : undefined), env);
  const interactive = interactiveAllowed(argv, dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY))
    && driver === undefined && !quiet;
  if (driver) {
    if (driver.id === "claude-code" && !json) note(`${CLAUDE_CODE_HINT}\n`);
    note(agentDetectedLines(driver));
  }
  if (driver?.id) dependencies = { ...dependencies, connect: { ...dependencies.connect, drivingAgent: driver.id } };
  const ui = interactive ? dependencies.prompts ?? clackPrompts((message) => note(`${message}\n`)) : undefined;
  const agentDeps = dependencies.agents ?? agentDependencies(dependencies.configContext, dependencies.fetch);
  let offered = false;
  const skillOffer = async (force = false): Promise<number> => {
    if (!ui || offered) return 0;
    offered = true;
    const inform = (message: string) => { try { ui.info(message); } catch { /* Optional output cannot invalidate the command. */ } };
    try {
      const cwd = dependencies.cwd ?? process.cwd();
      if (!force) {
        const present = await (dependencies.skillPresent ?? (() => relaySkillPresent(cwd, dependencies.configContext?.home ?? homedir(), env)))();
        if (present !== false) return 0;
      }
      if (!await ui.confirm("Install the Relay skill? The installer will ask which runtimes to install it for, and whether to install it for this folder or for you everywhere.")) return 0;
      try {
        await (dependencies.skillInstaller ?? (() => installRelaySkill(cwd, env)))();
        inform("The Relay skill is installed.");
        return 0;
      } catch {
        inform("The Relay skill was not installed. Your agent and your saved token are unchanged.");
        return force ? 1 : 0;
      }
    } catch (error) {
      inform("Skipped installing the Relay skill. Your agent and your saved token are unchanged.");
      if (error instanceof InteractiveCancelled && !force) throw error;
      return error instanceof InteractiveCancelled ? 0 : force ? 1 : 0;
    }
  };
  try {
    let args = argv;
    if (argv.includes("--install-skills")) {
      const home = dependencies.configContext?.home ?? homedir();
      const cwd = dependencies.cwd ?? process.cwd();
      const targets = await skillTargets(home, env);
      try {
        // Off a terminal, or with stdout promised to --json, the installer
        // paints nothing and speaks on stderr (skill-offer.ts).
        await (dependencies.skillInstaller ?? (() => installRelaySkill(cwd, env, relaySkillGlobalArgs(targets), !interactive)))();
      } catch {
        throw new CliError("The Relay skill was not installed. Nothing else was changed.", "refused");
      }
      args = argv.filter((arg) => arg !== "--install-skills");
      if (!args.length) return EXIT_CODES.ok;
    }
    const entry = interactiveEntry(args);
    if (ui && entry && entry.entry !== "root") {
      const selected = await chooseInteractiveCommand(entry.entry, entry.prefix, agentDeps, ui);
      if (!selected) return EXIT_CODES.ok;
      if (selected === "install-skill") return await skillOffer(true);
      args = selected;
    } else if (entry) args = [...args, "--help"];
    const rootHelpRequested = args.length === 0
      || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!));
    let helpHeading: string | undefined;
    if (rootHelpRequested && !json && !quiet) {
      const helpTTY = dependencies.helpTTY
        ?? Boolean(process.stdout.isTTY && process.stderr.isTTY);
      if (helpTTY) {
        await writeRelayHelpHeading(
          stdout,
          processPalette(),
          true,
        );
        helpHeading = "";
      } else {
        helpHeading = relayHelpHeading(processPalette());
      }
    }
    await createProgram({
      ...dependencies, agents: agentDeps, isInteractive: interactive, json, stderr,
      ...(helpHeading !== undefined ? { helpHeading } : {}),
      ...(quiet ? { stdout: () => undefined } : {}),
      ...(ui ? {
        prompts: ui,
        offerSkill: async () => { await skillOffer(); },
        readSecret: dependencies.readSecret ?? (() => ui.password("Paste your token")),
        confirmDelete: () => ui.confirm("Delete the selected agent? This cannot be undone."),
        confirmLogout: () => ui.confirm("Remove the saved token from this computer? The agent itself is not deleted."),
      } : {}),
    }).parseAsync(args, { from: "user" });
    return EXIT_CODES.ok;
  } catch (error) {
    if (error instanceof InteractiveCancelled) { note("Cancelled.\n"); return EXIT_CODES.ok; }
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version", "commander.help"].includes(error.code)) {
      return error.exitCode;
    }
    let secrets: string[] = [];
    try {
      secrets = await collectConfiguredTokens(dependencies.configContext);
    } catch {
      if (env.RELAY_AGENT_TOKEN) secrets = [env.RELAY_AGENT_TOKEN];
    }
    // One envelope for every failure, usage errors included, and one exit code
    // per class (exit-codes.ts). The text form keeps commander's own sentence
    // for a usage error (already written, with the Docs line) and Stripe's and
    // eas's shape for a question with no terminal: the flags, never a usage block.
    const failure = describeFailure(error, secrets);
    if (json) {
      stderr(jsonText({ error: failure.error, code: failure.code, next_step: failure.next_step }));
      return failure.exit;
    }
    if (error instanceof CommanderError) return failure.exit;
    if (error instanceof HeadlessPrompt) {
      const message = errorText(error, secrets);
      stderr(error.flags.length
        ? `Error: ${message}\nThere is no terminal here, so nothing was asked. Pass one of these instead:\n${error.flags.map((flag) => `  ${flag}`).join("\n")}\n`
        : `Error: ${message} ${error.nextStep}\n`);
      return failure.exit;
    }
    stderr(`Error: ${failure.error}\n`);
    return failure.exit;
  }
};
