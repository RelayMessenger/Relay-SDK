import { requireSubtitle } from "./agent-create.js";
import { openSavedAgentSession, savedAgentShareURL, type AgentSessionInput, type AgentSessionDependencies } from "./agent-session.js";
import { prepareAgentImage } from "./local-image.js";
import { uploadAgentImage } from "./agent-image-upload.js";
import { createAgentWithPicture, incompletePictureMessage } from "./agent-create.js";
import { homedir } from "node:os";
import { clackPrompts, chooseInteractiveCommand, interactiveAllowed, interactiveEntry, HeadlessPrompt, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { runConnect, ConnectFailure, type ConnectOptions as ConnectRunOptions } from "./connect.js";
import { codexCommand, runCodexBridge } from "./codex-bridge.js";
import { claudeCommand, runClaudeBridge } from "./claude-bridge.js";
import { openClaudeThreads } from "./claude-threads.js";
import { openCodexThreads } from "./codex-threads.js";
import { acpCommand, runAcpBridge } from "./acp-bridge.js";
import { openAcpSessions } from "./acp-threads.js";
import { runPiChannel } from "@relaymessenger/pi";
import { OwnerApprovals, piApprovals } from "./approvals.js";
import { sdkTerminalObserver, terminalEventLine } from "./terminal-watch.js";
import { dim, link } from "./ui-colour.js";
import { installRelaySkill, relaySkillGlobalArgs, relaySkillPresent } from "./skill-offer.js";
import { readHiddenToken } from "./secret-input.js";
import { renderTerminalQRForOutput, TerminalQRSizeError } from "./qr-terminal.js";
import { agentDependencies, deleteAgent, listAgents, selectAgentAuth, validateFirstName, validateHandle, type AgentDependencies } from "./agents.js";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type AgentImageRecipe,
  type ChatCreateParams,
  type ChatSendVoicememoParams,
  type ChatSetActivityParams,
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
import type { ConfigContext, RelayConsoleSession, RelayProfile, ResolvedAuth } from "./config.js";
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
import { consoleLogin, consoleLoginWithKey, consoleLoginOrReuse, consoleRequest, consoleSignOut, deleteConsoleAgent } from "./console-auth.js";
import { AGENTS_CAN_MESSAGE, peopleSwitch, removeAccess, setAccess, showAccess, updateReach, type AgentsCanMessage } from "./agent-access.js";
import { setReachPreset } from "./agent-access.js";
import { linkPhone, phoneLinkSentence } from "./phone-link.js";

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
  connect?: Partial<Pick<import("./connect.js").ConnectDependencies, "sniff" | "runCommand" | "startCommand" | "observer" | "bridge" | "renderQR" | "version" | "drivingAgent">>;
  /** Which runtime is driving this command; `@vercel/detect-agent` by default. */
  detectAgent?: () => Promise<import("@vercel/detect-agent").AgentResult>;
  terminalSession?: AgentSessionDependencies["session"];
  terminalIO?: AgentSessionDependencies["io"];
  terminalClient?: AgentSessionDependencies["client"];
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetch?: typeof fetch;
  /** Test/integration seam for the Console device-login flow. */
  consoleLogin?: () => Promise<RelayConsoleSession>;
  consoleRequest?: <T>(path: string, init?: RequestInit) => Promise<T>;
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

const subtitleText = (value: string): string => {
  const text = value.trim();
  if (!text || [...text].length > 60) throw new InvalidArgumentError("Subtitle must be 1 to 60 characters.");
  return text;
};

const descriptionText = (value: string): string => {
  const text = value.trim();
  if (!text || [...text].length > 2000) throw new InvalidArgumentError("Description must be 1 to 2000 characters.");
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
  const normalized = value.trim().replace(/^@/u, "");
  if (!normalized || normalized.startsWith("@") || /\s/.test(normalized)) {
    throw new InvalidArgumentError(
      "Handles must be non-empty and contain no spaces.",
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
    .helpOption("-h, --help", "help")
    .description("Message the agent on your computer from your phone")
    .version(`relaymessenger ${PACKAGE_VERSION}`, "-V, --version", "the version")
    .option("--json", "JSON output")
    .option("--no-input, --non-interactive", "no prompts")
    .option("--agent <auto|yes|no>", "runtime detection override (default auto)", agentModeValue)
    .option("-q, --quiet", "errors only")
    .option("--verbose", "request method, path, status, milliseconds on stderr")
    .option("--profile <name>", "the saved profile to use", (configContext.env ?? process.env).RELAY_PROFILE)
    .option("--install-skills", "Relay skill installation for local runtimes");
  program.exitOverride();
  // A usage error keeps commander's sentence and gains the Docs line; under
  // --json it prints nothing here, because runCLI prints the envelope (MCP's
  // protocol-error class obeys the same format as every other error; ledger
  // rows P05 and P49, captures/relay/exit-usage-badflag-json.txt).
  const usageError = (message: string, write: (value: string) => void): void => {
    if (!dependencies.json) write(`${message.replace(/(?:rly_|rel_org_)[A-Za-z0-9_-]+/gu, "[REDACTED]")}${DOCS_LINE}\n`);
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
    .argument("[agent]", "the runtime to connect")
    .description("connect a coding agent and wait for a reply")
    .helpGroup(HELP_GROUPS.getStarted)
    .option("--new", "a new agent")
    .option("--handle <handle>", "the agent's handle")
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .option("--image <path-or-url>", "a picture file or https:// address")
    .option("--avatar <file>", "a local PNG or JPEG picture")
    // gh's `auth login --with-token` (ledger row P25): the token comes down a
    // pipe and never touches `ps` or the shell history. `--token` stays for
    // scripts and is the visible one.
    .option("--with-token", "an existing token from a pipe")
    .option("--token <token>", "an existing token, visible in shell history")
    .option("--allow <handles>", "allowed sender handles, comma-separated; default everyone")
    .option("-y, --yes", "token replacement without asking")
    .option("--dry-run", "the plan, nothing changed")
    .option("--no-start", "no start offer")
    .option("--no-skill", "no Relay skill offer")
    .option("--json", "JSON output")
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
        // Codex, Cursor, Gemini CLI, OpenCode and Pi cannot start a turn of their
        // own, so connect stays and answers for them: Codex over its app-server
        // (codex-bridge.ts), the others over ACP (acp-bridge.ts). Control-C ends
        // the wait and the command.
        bridge: async (input) => {
          const control = new AbortController();
          const stop = (): void => control.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          const relayClient = () => new Relay({ apiKey: input.token, baseURL: input.apiURL, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
          // What the coding agent would ask at its own terminal goes to the
          // agent's owners in Relay, as a card; only an owner's tap answers.
          const approvals = new OwnerApprovals({ client: relayClient(), say: input.say });
          try {
            if (input.kind === "pi") {
              await runPiChannel({
                agentToken: input.token,
                baseURL: input.apiURL,
                piCommand: input.command,
                relay: relayClient(),
                approvals: piApprovals(approvals),
              }, control.signal);
            } else if (input.kind === "claude") {
              await runClaudeBridge({
                client: relayClient(),
                media: { token: input.token, apiURL: input.apiURL, context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
                claude: await claudeCommand(input.command, env),
                cwd: input.cwd,
                threads: await openClaudeThreads({ apiURL: input.apiURL, handle: input.handle }, configContext),
                mcp: { url: input.mcpURL, token: input.token },
                approvals,
                signal: control.signal,
                say: input.say,
              });
            } else if (input.kind === "acp") {
              await runAcpBridge({
                client: relayClient(),
                media: { token: input.token, apiURL: input.apiURL, context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
                acp: await acpCommand(input.command, input.acpArgs ?? [], env),
                cwd: input.cwd,
                // Relay's own tools travel through the agent's session.
                mcp: { url: input.mcpURL, token: input.token },
                label: input.label,
                approvals,
                // The chat's ACP session outlives this run, so a restart picks
                // every chat up where it stopped (acp-threads.ts).
                sessions: await openAcpSessions({ apiURL: input.apiURL, handle: input.handle }, configContext),
                signal: control.signal,
                say: input.say,
              });
            } else {
              await runCodexBridge({
                client: relayClient(),
                media: { token: input.token, apiURL: input.apiURL, context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
                codex: await codexCommand(input.command, env),
                cwd: input.cwd,
                // The chat's Codex thread outlives this run, so a restart picks
                // every chat up where it stopped (codex-threads.ts).
                threads: await openCodexThreads({ apiURL: input.apiURL, handle: input.handle }, configContext),
                // Every thread gets Relay's hosted MCP server, which reads
                // its token from RELAY_AGENT_TOKEN (codex-bridge.ts).
                agentToken: input.token,
                mcpURL: input.mcpURL,
                approvals,
                signal: control.signal,
                say: input.say,
              });
            }
          } finally {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
          }
        },
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.offerSkill ? { offerSkill: dependencies.offerSkill } : {}),
        consoleLogin: dependencies.consoleLogin ?? (() => consoleLoginOrReuse({
          context: configContext,
          apiURL: defaultCreationApiURL(),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          // Console login has no prompts; Relay Console names a first
          // organization itself (GET /me).
          stderr,
          nonInteractive: dependencies.isInteractive === false,
        })),
        ...dependencies.connect,
      });
    });

  program
    .command("watch")
    .argument("[handle]", "the agent to watch")
    .description("see messages arrive and replies go out, live")
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
    .description("forward each event to a route on this computer")
    .helpGroup(HELP_GROUPS.everyDay)
    .requiredOption("--forward-to <url>", "local address for signed event copies")
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
    .description("check this computer and every saved agent")
    .helpGroup(HELP_GROUPS.everyDay)
    .option("--offline", "local checks only")
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
    .description("create, update, list and delete saved agents")
    .helpGroup(HELP_GROUPS.everyDay);
  agents.command("create")
    .description("create an agent and save its token privately")
    .addOption(new Option("--api-url <url>", "the Relay API address to use").argParser(validateApiURL).hideHelp())
    .option("--handle <handle>", "the agent's handle")
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .option("--image <path-or-url>", "a picture file or https:// address")
    .option("--image-url <url>", "a picture at an https:// address")
    .option("--image-recipe <json-file>", "a Relay picture recipe accompanying the picture")
    .option("--json", "JSON output")
    .action(async (options: { apiUrl?: string; json?: boolean; handle?: string; name?: string; subtitle?: string; description?: string; image?: string; imageUrl?: string; imageRecipe?: string }, command: Command) => {
      if (options.handle !== undefined) validateHandle(options.handle);
      if (options.name !== undefined) validateFirstName(options.name);
      if (options.image !== undefined && options.imageUrl !== undefined) throw new Error("Choose --image or --image-url, not both.");
      const imageRecipe: AgentImageRecipe | undefined = options.imageRecipe === undefined
        ? undefined : await readImageRecipe(options.imageRecipe);
      const requestedProfile = program.getOptionValueSource("profile") === "cli"
        ? globals(command).profile : undefined;
      if (requestedProfile) {
        validateProfileName(requestedProfile);
        if (Object.hasOwn((await agentDeps.read()).profiles, requestedProfile)) {
          throw new Error("Profile already exists; choose a new profile name.");
        }
      }
      options.subtitle = await requireSubtitle(options.subtitle, {
        prompts: dependencies.prompts,
        nonInteractive: globals(command).nonInteractive === true || options.json === true || globals(command).json === true || dependencies.isInteractive === false,
      });
      const session = await (dependencies.consoleLogin?.() ?? consoleLoginOrReuse({
        context: configContext,
        apiURL: options.apiUrl ?? defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.prompts ? { prompts: dependencies.prompts } : {}),
        stderr,
        nonInteractive: globals(command).nonInteractive === true || globals(command).json === true || dependencies.isInteractive === false,
      }));
      const created = await createAgentWithPicture({
        makeDefault: true,
        ...(program.getOptionValueSource("profile") === "cli" && globals(command).profile ? { profile: globals(command).profile } : {}),
        apiURL: options.apiUrl ?? defaultCreationApiURL(),
        ...(options.handle === undefined ? {} : { handle: options.handle }),
        ...(options.name === undefined ? {} : { firstName: options.name }),
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageUrl === undefined ? {} : { imageURL: options.imageUrl }),
        ...(imageRecipe === undefined ? {} : { imageRecipe }),
        ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
        ...(configContext.home ? { home: configContext.home } : {}),
      }, agentDeps, dependencies.fetch);
      const result = { ...created.result, organization_id: session.organization_id };
      const imageUpdate = created.image;
      if (globals(command).json) output({ ...result, ...(imageUpdate ? { image: imageUpdate } : {}) });
      else {
        stdout(`${result.display_name} (@${result.handle})\nProfile: ${result.profile}\n${result.share_url}\nToken saved in ${configPath(configContext)}\n`);
        const liveViewFollows = imageUpdate?.status !== "incomplete" && willShowSavedAgent(command);
        if (!liveViewFollows) {
          try { stdout(renderTerminalQRForOutput(result.share_url)); }
          catch (error) {
            stderr(error instanceof TerminalQRSizeError
              ? `${error.message}\n`
              : "Relay could not draw the QR code. Use the link above instead.\n");
          }
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
    .description("list the agents saved on this computer")
    .option("--json", "JSON output")
    .action(async () => {
      let firstFailure: Error | undefined;
      const result = await listAgents(agentDeps, (error) => { firstFailure ??= error; });
      output(result);
      // Keep successful entries on stdout; the first failed entry determines
      // the standard stderr envelope and classified command exit.
      if (firstFailure) throw firstFailure;
    });
  agents.command("update").argument("<handle>", "agent handle", handle)
    .description("update an agent's name or subtitle")
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .option("--json", "JSON output")
    .action(async (agentHandle: string, options: { name?: string; subtitle?: string; description?: string }, command: Command) => {
      const body = {
        handle: agentHandle,
        ...(options.name === undefined ? {} : { first_name: validateFirstName(options.name) }),
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        ...(options.description === undefined ? {} : { description: options.description }),
      };
      if (Object.keys(body).length === 1) throw new Error("Choose --name, --subtitle or --description.");
      const auth = await selectAgentAuth(agentHandle, globals(command).profile, agentDeps);
      await agentDeps.client(auth.token, auth.apiURL).contactCard.update(body, { maxRetries: 0 });
      output(safeMetadata({ ok: true, handle: agentHandle, profile: auth.profile, token: "unchanged" }, [auth.token]));
    });
  agents.command("delete").argument("<handle>", "agent handle", handle)
    .description("delete an agent and remove its saved token")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, _options: object, command: Command) => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmDelete && !await dependencies.confirmDelete()) throw new InteractiveCancelled();
      output(await deleteAgent(agentHandle, globals(command).profile, {
        ...agentDeps,
        deleteConsole: (handle, apiURL, agentToken) => deleteConsoleAgent({
          context: configContext, apiURL,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        }, handle, agentToken),
      }));
    });

  // Who may start a chat with an agent: Relay Console's "Available to" field
  // and its Always Allow and Never Allow lists, through the Console's own routes.
  const accessRequest = <T>(path: string, init?: RequestInit): Promise<T> =>
    dependencies.consoleRequest?.<T>(path, init) ?? consoleRequest<T>({
      context: configContext,
      apiURL: defaultCreationApiURL(),
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    }, path, init);
  const ACCESS_HELP = `
People in your organization can always message the agent, whatever these
settings say. Private turns people off and sets other agents to nobody, so
only your organization and the handles on Always Allow can start a chat.
Open turns both back on; agents are open by default. Ongoing conversations
continue whatever you choose.

Examples:
  relay agents access show weather
  relay agents access private weather
  relay agents access open weather
  relay agents access update weather --people off --agents nobody
  relay agents access allow weather alice
  relay agents access deny weather spam_bot
  relay agents access remove weather alice
`;
  const access = agents.command("access")
    .description("show and change who can message an agent");
  access.addHelpText("after", ACCESS_HELP);
  access.command("show").argument("<handle>", "agent handle", handle)
    .description("show who can start a chat with an agent")
    .option("--json", "JSON output")
    .action(async (agentHandle: string) => {
      output(await showAccess(accessRequest, agentHandle));
    });
  access.command("update").argument("<handle>", "agent handle", handle)
    .description("change who can start a chat with an agent")
    .addOption(new Option("--people <on|off>", "People in the Relay app").argParser(peopleSwitch))
    .addOption(new Option("--agents <who>", "Other agents").choices(AGENTS_CAN_MESSAGE))
    .option("--json", "JSON output")
    .addHelpText("after", ACCESS_HELP)
    .action(async (agentHandle: string, options: { people?: boolean; agents?: AgentsCanMessage }) => {
      output(await updateReach(accessRequest, agentHandle, {
        ...(options.people === undefined ? {} : { people: options.people }),
        ...(options.agents === undefined ? {} : { agents: options.agents }),
      }));
    });
  access.command("private").argument("<handle>", "agent handle", handle)
    .description("let only your organization and Always Allow message it")
    .option("--json", "JSON output")
    .addHelpText("after", ACCESS_HELP)
    .action(async (agentHandle: string) => {
      output(await setReachPreset(accessRequest, agentHandle, "private"));
    });
  access.command("open").argument("<handle>", "agent handle", handle)
    .description("let people and other agents message it")
    .option("--json", "JSON output")
    .addHelpText("after", ACCESS_HELP)
    .action(async (agentHandle: string) => {
      output(await setReachPreset(accessRequest, agentHandle, "open"));
    });
  access.command("allow").argument("<handle>", "agent handle", handle).argument("<contact>", "person's or agent's handle")
    .description("put a person or agent on Always Allow")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, contact: string) => {
      output(await setAccess(accessRequest, agentHandle, contact, "allow"));
    });
  access.command("deny").argument("<handle>", "agent handle", handle).argument("<contact>", "person's or agent's handle")
    .description("put a person or agent on Never Allow")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, contact: string) => {
      output(await setAccess(accessRequest, agentHandle, contact, "deny"));
    });
  access.command("remove").argument("<handle>", "agent handle", handle).argument("<contact>", "person's or agent's handle")
    .description("take a person or agent off both lists")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, contact: string) => {
      output(await removeAccess(accessRequest, agentHandle, contact));
    });

  // Optional: link a phone so this account is also the Relay app account.
  const phone = program.command("phone")
    .description("link your phone to your Relay account")
    .helpGroup(HELP_GROUPS.everythingElse);
  phone.command("link")
    .description("text a code to your phone and link it")
    .option("--number <number>", "your number, with its country code")
    .option("--code <code>", "the code from the text message")
    .option("--json", "JSON output")
    .addHelpText("after", `
Linking is optional; no other command needs it. Once linked, the Relay app
signs in to this same account with your phone.

Without a terminal, run it twice: once with --number to get the code, then
again with --number and --code.
`)
    .action(async (options: { number?: string; code?: string }, command: Command) => {
      const interactive = !globals(command).nonInteractive && !globals(command).json && dependencies.isInteractive === true;
      const result = await linkPhone(options, {
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(interactive && dependencies.prompts ? { prompts: dependencies.prompts } : {}),
        stderr,
      });
      output(result);
      const sentence = phoneLinkSentence(result);
      if (sentence && !globals(command).json) stderr(`${sentence}\n`);
    });

  const authCommands = program.command("auth", { hidden: true }).description("manage the token this computer signs in with").helpGroup(HELP_GROUPS.everythingElse);
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
      if (saved?.agent_token === resolved.token && validateApiURL(saved.api_url ?? defaultCreationApiURL()) === resolved.apiURL) {
        await showSavedAgent(command, { profile: resolved.profile, apiURL: resolved.apiURL });
      }
  };
  const authLogout = async (_options: object, command: Command, clearConsole = false): Promise<void> => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmLogout && !await dependencies.confirmLogout()) throw new InteractiveCancelled();
      const config = await readConfig(configContext);
      const profile = validateProfileName(
        globals(command).profile ?? config.current_profile,
      );
      const selected = config.profiles[profile];
      if (!selected) throw new CliError(`Relay profile ${profile} does not exist.`, "not_found");
      const clearedConsole = clearConsole && config.console !== undefined;
      // End the Relay-Auth session on the server before the local copy goes;
      // a server miss still removes the local session (the token expires by itself).
      if (clearedConsole) {
        await consoleSignOut({ context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
        delete config.console;
      }
      // clig.dev, Output: "If you change state, tell the user" — and only when
      // it changed. With nothing saved there is nothing to remove, so the
      // file is left alone and the answer says so (ledger row P14).
      if (selected.agent_token === undefined) {
        if (clearedConsole) await writeConfig(config, configContext);
        output({ ok: true, profile, token: "none", ...(clearedConsole ? { console: "removed" } : {}) });
        if (!clearedConsole && !globals(command).json && !globals(command).quiet) stderr(`No token was saved for profile ${profile}.\n`);
        return;
      }
      const { agent_token: _removed, ...withoutToken } = selected;
      config.profiles[profile] = withoutToken;
      await writeConfig(config, configContext);
      output({ ok: true, profile, token: "removed", ...(clearedConsole ? { console: "removed" } : {}) });
  };
  const addAuthLogin = (command: Command): void => {
    command
      .option("--with-token", "an existing token from a pipe")
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
    .description("save a token for this computer");
  addAuthLogin(authLoginCommand);
  const authStatusCommand = authCommands.command("status")
    .description("show the token source without revealing the token");
  addAuthStatus(authStatusCommand);
  const authLogoutCommand = authCommands.command("logout")
    .description("remove the selected profile's stored token");
  addAuthLogout(authLogoutCommand);

  // Linq-style top-level names; the hidden `auth` tree remains compatible with
  // existing scripts and is still the canonical implementation underneath.
  const loginCommand = program.command("login")
    .description("sign in to Relay Console")
    .helpGroup(HELP_GROUPS.everythingElse);
  loginCommand
    .option("--with-token", "an existing token from a pipe")
    .option("--website <domain>", "organization website; empty value clears it")
    .action(async (options: { withToken?: boolean; website?: string }, command: Command) => {
      if (options.withToken) {
        if (!dependencies.readStdin && process.stdin.isTTY) {
          throw new CliError("Pipe an organization API key into relay login --with-token.", "not_a_tty");
        }
        const session = await consoleLoginWithKey({
          context: configContext,
          apiURL: defaultCreationApiURL(),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        }, await readStdinText());
        output(safeMetadata(
          { ok: true, type: session.type, organization_id: session.organization_id, token: "stored" },
          [session.organization_key],
        ));
        return;
      }
      const session = await consoleLoginOrReuse({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.prompts ? { prompts: dependencies.prompts } : {}),
        stderr,
        ...(options.website === undefined ? {} : { website: options.website }),
        nonInteractive: false,
      });
      output({
        ok: true,
        ...(session.type === "organization_key" ? { type: session.type } : { user: session.user }),
        organization_id: session.organization_id,
        token: "stored",
      });
    });
  const whoamiCommand = program.command("whoami")
    .description("show who is signed in, without the token")
    .helpGroup(HELP_GROUPS.everythingElse);
  whoamiCommand.action(async (options: object, command: Command) => {
    const current = (await readConfig(configContext)).console;
    if (current?.type === "organization_key" && !globals(command).profile) {
      const me = await consoleRequest<{ org: { id: string } }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      output({ type: current.type, organization_id: me.org.id });
      return;
    }
    try {
      await authStatus(options, command);
    } catch (error) {
      // A successful Console login does not create an Agent Token. Preserve
      // existing agent/profile behavior, but report that signed-in identity
      // rather than telling a Console-only user to paste another token.
      if (!(error instanceof CliError) || error.code !== "no_token") throw error;
      if (globals(command).profile) throw error;
      const config = await readConfig(configContext);
      if (!config.console) throw error;
      const me = await consoleRequest<{
        user: { id: string; email: string; name?: string };
        org: { id: string };
      }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      output({
        user: { id: me.user.id, email: me.user.email, ...(me.user.name ? { name: me.user.name } : {}) },
        organization_id: me.org.id,
      });
    }
  });
  const logoutCommand = program.command("logout")
    .description("remove the saved sign-in")
    .helpGroup(HELP_GROUPS.everythingElse);
  logoutCommand.action((options: object, command: Command) => authLogout(options, command, true));

  const organization = program.command("organization")
    .alias("org")
    .description("manage the signed-in organization")
    .helpGroup(HELP_GROUPS.everythingElse);
  organization.command("show")
    .description("show the signed-in organization")
    .action(async () => {
      output(await consoleRequest({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me"));
    });
  organization.command("update")
    .description("change the organization name or website")
    .option("--name <name>", "the display name")
    .option("--website <domain>", "organization website; empty value clears it")
    .action(async (options: { name?: string; website?: string }) => {
      if (options.name === undefined && options.website === undefined) {
        throw new CliError("Choose --name or --website.", "usage");
      }
      const me = await consoleRequest<{ org: { id: string } }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      output(await consoleRequest({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, `/orgs/${me.org.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.website === undefined ? {} : { website: options.website }),
        }),
      }));
    });

  const profiles = program.command("profiles", { hidden: true }).description("add, use, remove and list saved profiles").helpGroup(HELP_GROUPS.everythingElse);
  profiles
    .command("add")
    .argument("<name>", "profile name", validateProfileName)
    .addOption(new Option("--api-url <url>", "the Relay API address this profile uses")
      .argParser(validateApiURL).makeOptionMandatory().hideHelp())
    .description("add a profile without a token")
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
    .description("select the current profile")
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
    .description("remove a profile that is not current")
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
    .description("list profiles without their tokens")
    .action(async () => {
      const config = await readConfig(configContext);
      output({
        current_profile: config.current_profile,
        profiles: Object.entries(config.profiles).map(([name, profile]) => ({
          name,
          current: name === config.current_profile,
          api_url: profile.api_url ?? defaultCreationApiURL(),
          has_token: Boolean(profile.agent_token),
        })),
      });
    });

  program
    .command("docs", { hidden: true })
    .argument("[section]", "documentation section")
    .option("--list", "section names, one per line")
    .description("read Relay documentation or show its address")
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
    .description("show where Relay keeps its config file")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(() => output({ path: configPath(configContext) }));

  const chats = program.command("chats", { hidden: true }).helpGroup(HELP_GROUPS.everythingElse)
    .description("read and update chats");
  chats.addHelpText("after",
    "\nTo start or join a chat that includes a person, every agent in it must already be one of that person's contacts and not blocked. "
    + "Chats between agents only need no such contact.\n");
  chats
    .command("list")
    .description("list this agent's chats, one page at a time")
    .option("--cursor <cursor>", "the cursor from the previous page")
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
    .description("create a chat with up to 7 participants")
    .requiredOption("--from <handle>", "sender handle", handle)
    .requiredOption("--to <handles...>", "up to six recipients, repeated or comma-separated", recipients)
    .requiredOption("--text <text>", "the text to send")
    .requiredOption("--idempotency-key <key>", "duplicate-send prevention key")
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
    .description("rename a group chat or change its picture")
    .argument("<chat-id>", "the chat ID")
    .option("--display-name <name>", "the name people see for this chat")
    .option("--group-icon <attachment-id-or-https-url>", "the picture for this chat")
    .option("--clear-group-icon", "no chat picture")
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
    .description("leave a chat")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.leaveChat(chatID)));
  chats
    .command("read")
    .description("mark a chat as read")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.markAsRead(chatID);
      output(voidResult);
    });

  const typing = chats.command("typing").description("start or stop the typing indicator");
  typing
    .command("start")
    .description("show this agent as typing")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.startTyping(chatID);
      output(voidResult);
    });
  typing
    .command("stop")
    .description("stop showing this agent as typing")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.stopTyping(chatID);
      output(voidResult);
    });

  const activity = chats.command("activity").description("get, set or clear this agent's task activity");
  activity
    .command("get")
    .description("get this agent's activity in a chat")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.getActivity(chatID)));
  activity
    .command("set")
    .description("start a task activity or refresh its current id")
    .argument("<chat-id>", "the chat ID")
    .requiredOption("--text <text>", "1–21 visible characters, at most 1024 bytes")
    .option("--emoji <emoji>", "one Unicode emoji")
    .option("--clear-emoji", "send a null emoji")
    .option("--activity-id <uuid>", "refresh this task instead of replacing it")
    .action(async (
      chatID: string,
      options: { text: string; emoji?: string; clearEmoji?: boolean; activityId?: string },
      command: Command,
    ) => {
      if (options.emoji !== undefined && options.clearEmoji) {
        throw new Error("Choose --emoji or --clear-emoji, not both.");
      }
      const body = {
        text: options.text,
        ...(options.emoji === undefined ? {} : { emoji: options.emoji }),
        ...(options.clearEmoji ? { emoji: null } : {}),
        ...(options.activityId === undefined ? {} : { activity_id: options.activityId }),
      } satisfies ChatSetActivityParams;
      output(await (await clientFor(command)).chats.setActivity(chatID, body));
    });
  activity
    .command("clear")
    .description("clear this agent's activity, optionally matching a task")
    .argument("<chat-id>", "the chat ID")
    .option("--activity-id <uuid>", "clear only this task")
    .action(async (
      chatID: string,
      options: { activityId?: string },
      command: Command,
    ) => {
      await (await clientFor(command)).chats.clearActivity(
        chatID,
        options.activityId === undefined ? {} : { activity_id: options.activityId },
      );
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
    .argument("<handle>", "participant handle", handle)
    .option("--hide-history", "new messages only for the added agent")
    .option("--no-hide-history", "old messages visible to the added agent")
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
    .argument("<handle>", "participant handle", handle)
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

  const chatMessages = chats.command("messages").description("read and send messages in a chat");
  chatMessages
    .command("list")
    .description("list a chat's messages, one page at a time")
    .argument("<chat-id>", "the chat ID")
    .option("--cursor <cursor>", "the cursor from the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .option("--order <order>", "asc (oldest first) or desc (newest first)")
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
    .option("--idempotency-key <key>", "duplicate-send prevention key")
    .option("--silent", "delivery without a banner or sound")
    .action(async (
      chatID: string,
      options: { text: string; idempotencyKey?: string; silent?: boolean },
      command: Command,
    ) => {
      const body = {
        message: textContent(options.text, options.idempotencyKey ?? crypto.randomUUID(), options.silent),
      } satisfies MessageSendParams;
      output(await (await clientFor(command)).chats.messages.send(chatID, body));
    });

  chats
    .command("voice-memo")
    .description("send a voice memo to a chat")
    .argument("<chat-id>", "the chat ID")
    .option("--attachment-id <id>", "the completed attachment")
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

  const messages = program.command("messages", { hidden: true }).description("read, send and react to messages").helpGroup(HELP_GROUPS.everythingElse);
  messages
    .command("send")
    .description("send a message to the handles you name")
    .requiredOption("--to <handles...>", "up to six recipients, repeated or comma-separated", recipients)
    .requiredOption("--text <text>", "the text to send")
    .option("--idempotency-key <key>", "duplicate-send prevention key")
    .option("--silent", "delivery without a banner or sound")
    .action(async (
      options: { to: string[]; text: string; idempotencyKey?: string; silent?: boolean },
      command: Command,
    ) => {
      if (options.to.length > 6) throw new Error("A Chat accepts at most 6 recipient Handles (7 total participants).");
      const body = {
        to: options.to,
        message: textContent(options.text, options.idempotencyKey ?? crypto.randomUUID(), options.silent),
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
    .description("list the replies to a message")
    .argument("<message-id>", "the message ID")
    .option("--cursor <cursor>", "the cursor from the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .option("--order <order>", "asc (oldest first) or desc (newest first)")
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
    .option("--custom-emoji <emoji>", "the custom reaction emoji")
    .option("--part-index <number>", "the message part index, counting from zero", integer)
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

  const attachments = program.command("attachments", { hidden: true }).description("upload files and manage the ones you uploaded").helpGroup(HELP_GROUPS.everythingElse);
  attachments
    .command("allocate")
    .description("reserve a file slot and get its upload address")
    .requiredOption("--filename <name>", "the name of the uploaded file")
    .requiredOption("--content-type <type>", "file MIME type")
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
    .description("upload a file from this computer")
    .argument("<file>", "the file to upload")
    .option("--content-type <type>", "file MIME type")
    .action(async (
      file: string,
      options: { contentType?: string },
      command: Command,
    ) => {
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new Error("Attachment path is not a file.");
      const data = await readFile(file);
      const filename = file.split(/[\\/]/).pop() ?? "attachment";
      const signatures: [string, SupportedContentType][] = [
        ["89504e47", "image/png"],
        ["ffd8ff", "image/jpeg"],
        ["47494638", "image/gif"],
        ["25504446", "application/pdf"],
      ];
      const header = data.subarray(0, 4).toString("hex");
      const sniffed = signatures.find(([signature]) => header.startsWith(signature))?.[1]
        ?? (data.subarray(0, 4).toString("ascii") === "RIFF"
          && data.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined);
      const extensions: Record<string, SupportedContentType> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", pdf: "application/pdf", heic: "image/heic", heif: "image/heif",
        tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", ico: "image/x-icon",
        mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/x-m4a",
        wav: "audio/x-wav", aac: "audio/aac", txt: "text/plain", md: "text/markdown",
        csv: "text/csv", html: "text/html", vcf: "text/vcard", ics: "text/calendar",
      };
      const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
      const contentType = options.contentType !== undefined
        ? nonempty("Content type", options.contentType) as SupportedContentType
        : sniffed ?? (extension && Object.hasOwn(extensions, extension) ? extensions[extension] : undefined);
      if (!contentType) throw new Error("Could not detect the file type. Set --content-type to the file's MIME type.");
      const client = await clientFor(command);
      const allocation = await client.attachments.create({
        filename,
        content_type: contentType,
        size_bytes: metadata.size,
      });
      await client.attachments.upload(allocation, data);
      output(allocation);
    });
  attachments
    .command("get")
    .description("show one uploaded file")
    .argument("<attachment-id>", "the attachment ID")
    .action(async (attachmentID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).attachments.retrieve(attachmentID)));
  attachments
    .command("delete")
    .description("delete an uploaded file")
    .argument("<attachment-id>", "the attachment ID")
    .action(async (attachmentID: string, _options: object, command: Command) => {
      await (await clientFor(command)).attachments.delete(attachmentID);
      output(voidResult);
    });

  const blocked = program.command("blocked-handles", { hidden: true }).description("block, unblock and list handles").helpGroup(HELP_GROUPS.everythingElse);
  blocked
    .command("list")
    .description("list the handles this agent has blocked")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).blockedHandles.list()));
  blocked
    .command("add")
    .description("block a handle from reaching this agent")
    .argument("<handle>", "handle", handle)
    .option("--reason <reason>", "the reason for blocking this handle")
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
    .argument("<handle>", "handle", handle)
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

  const webhooks = program.command("webhooks", { hidden: true }).description("list event types and manage where they go").helpGroup(HELP_GROUPS.everythingElse);
  webhooks
    .command("events")
    .description("list every event type Relay can send")
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
    .description("watch events with the older command name")
    .helpGroup(HELP_GROUPS.unlisted)
    .command("listen")
    .option("--forward-to <url>", "local address for signed event copies")
    .requiredOption(
      "--acknowledge-events",
      "mark test-agent events as read",
    )
    .description("print incoming events and optionally forward signed copies")
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
    .description("list where Relay sends this agent's events")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookSubscriptions.list()));
  subscriptions
    .command("get")
    .description("show one webhook subscription")
    .argument("<subscription-id>", "the webhook subscription ID")
    .action(async (subscriptionID: string, _options: object, command: Command) =>
      output(
        await (await clientFor(command)).webhookSubscriptions.retrieve(
          subscriptionID,
        ),
      ));
  subscriptions
    .command("create")
    .description("send chosen events to an address you own")
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
    .description("change a subscription's address, events or state")
    .argument("<subscription-id>", "the webhook subscription ID")
    .option("--target-url <url>", "the address that receives webhook events")
    .option("--event <events...>", "the event types this subscription receives")
    .option("--active", "delivery enabled")
    .option("--inactive", "delivery disabled")
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
    .description("stop sending events to that address")
    .argument("<subscription-id>", "the webhook subscription ID")
    .action(async (subscriptionID: string, _options: object, command: Command) => {
      await (await clientFor(command)).webhookSubscriptions.delete(subscriptionID);
      output(voidResult);
    });

  const contactCard = program.command("contact-card", { hidden: true }).description("set the name and picture people see").helpGroup(HELP_GROUPS.everythingElse);
  contactCard
    .command("get")
    .description("show this agent's name and picture")
    .option("--handle <handle>", "the agent's handle", handle)
    .action(async (options: { handle?: string }, command: Command) =>
      output(await (await clientFor(command)).contactCard.retrieve(options)));
  const contactCardHandle = async (client: Relay, explicit?: string): Promise<string> => {
    if (explicit) return explicit;
    const cards = await client.contactCard.retrieve({});
    const agents = cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active);
    if (agents.length !== 1) throw new Error("This token must belong to exactly one active agent.");
    return agents[0]!.handle;
  };
  contactCard
    .command("setup")
    .description("set this agent's name and picture the first time")
    .option("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the display name")
    .addOption(new Option("--first-name <name>", "the display name").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--image-url <url>", "a picture at an https:// address")
    .action(async (
      options: {
        handle?: string;
        name?: string; subtitle?: string; description?: string;
        firstName?: string;
        lastName?: string;
        imageUrl?: string;
      },
      command: Command,
    ) => {
      const selected = await resolveClient(globals(command).profile);
      const client = selected.client;
      const body = {
        handle: await contactCardHandle(client, options.handle),
        first_name: nonempty("Name", options.name ?? options.firstName ?? ""),
        ...(options.lastName ? { last_name: options.lastName } : {}),
        ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
      } satisfies ContactCardCreateParams;
      output(await client.contactCard.create(body));
    });
  contactCard
    .command("update")
    .alias("set")
    .description("change this agent's name or picture")
    .option("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .addOption(new Option("--first-name <name>", "the display name").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--clear-last-name", "no second name")
    .option("--image <path-or-url>", "a picture file or https:// address")
    .option("--image-url <url>", "a picture at an https:// address")
    .option("--attachment-id <id>", "the completed attachment")
    .option("--image-recipe <json-file>", "a Relay picture recipe accompanying the picture")
    .option("--clear-image-url", "no picture")
    .action(async (
      options: {
        handle?: string;
        name?: string; subtitle?: string; description?: string;
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
      const selected = await resolveClient(globals(command).profile);
      const client = selected.client;
      const body = {
        handle: await contactCardHandle(client, options.handle),
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        ...(options.description === undefined ? {} : { description: options.description }),
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
        const rawOutcome = await uploadAgentImage({ handle: body.handle,
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
      output(await client.contactCard.update(body));
    });
  contactCard
    .command("share")
    .description("share this agent's card into a chat")
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
    .description("show exit codes and their meanings")
    .helpGroup(HELP_GROUPS.unlisted)
    .configureHelp({ formatHelp: () => `${exitCodesHelp()}\n` })
    .action(() => stdout(exitCodesHelp()));

  // Last, so only the root's own help command takes this group: set earlier, the
  // default would be inherited by every subcommand and put an "Everything else"
  // heading on ten help screens that have no such section.
  program.commandsGroup(HELP_GROUPS.everythingElse).helpCommand(false);
  program.command("help")
    .argument("[command]", "command to show help for")
    .description("show what a command does")
    .action((name?: string) => {
      const target = name === undefined ? program : program.commands.find(
        (command) => command.name() === name || command.aliases().includes(name),
      );
      if (!target) {
        program.showHelpAfterError(!dependencies.json);
        return program.error(`error: unknown command '${name}'`, { code: "commander.unknownCommand", exitCode: 2 });
      }
      target.help();
    });

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
  const helpRequested = argv.length === 0
    || argv.includes("--help")
    || argv.includes("-h")
    || argv[0] === "help";
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
    if (!helpRequested && driver.id === "claude-code" && !json) note(`${CLAUDE_CODE_HINT}\n`);
    if (!helpRequested) note(agentDetectedLines(driver));
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
          true,
        );
        helpHeading = "";
      } else {
        helpHeading = relayHelpHeading();
      }
    }
    await createProgram({
      ...dependencies, isInteractive: interactive, json, stderr,
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
    if (error instanceof CommanderError) {
      // Parser errors were printed by configureOutput; a raw coercion error
      // thrown inside an action has not passed through that reporter.
      const alreadyReported = !(error instanceof InvalidArgumentError) && [
        "commander.unknownOption", "commander.unknownCommand", "commander.missingArgument",
        "commander.optionMissingArgument", "commander.missingMandatoryOptionValue",
        "commander.excessArguments", "commander.invalidArgument",
      ].includes(error.code);
      if (error.message && !alreadyReported) stderr(`Error: ${failure.error}\n${DOCS_LINE}\n`);
      return failure.exit;
    }
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
