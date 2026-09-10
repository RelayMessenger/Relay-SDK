import { openSavedAgentSession, type AgentSessionInput, type AgentSessionDependencies } from "./agent-session.js";
import { prepareAgentImage } from "./local-image.js";
import { uploadAgentImage } from "./agent-image-upload.js";
import { createAgentWithPicture, incompletePictureMessage } from "./agent-create.js";
import { homedir } from "node:os";
import { clackPrompts, chooseInteractiveCommand, interactiveAllowed, interactiveEntry, HeadlessPrompt, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { runConnect, ConnectFailure, type ConnectOptions as ConnectRunOptions } from "./connect.js";
import { sdkTerminalObserver } from "./terminal-watch.js";
import { installRelaySkill, relaySkillPresent } from "./skill-offer.js";
import { readHiddenToken } from "./secret-input.js";
import { renderTerminalQR } from "./qr-terminal.js";
import { connectAgentToRuntime, connectOptions, connectTarget, type ConnectOptions } from "./agent-handoff.js";
import { agentDependencies, agentRecord, createAgent, deleteAgent, listAgents, type AgentDependencies } from "./agents.js";
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
import type { ConfigContext, RelayProfile } from "./config.js";
import {
  DEFAULT_API_URL,
  defaultCreationApiURL,
  collectConfiguredTokens,
  configPath,
  readConfig,
  resolveAuth,
  validateApiURL,
  validateProfileName,
  validateToken,
  writeConfig,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { errorText, jsonText, safeMetadata } from "./output.js";
import { listenForAgentEvents } from "./event-listen.js";

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
  beforeSetup?: () => Promise<void>;
  /** The one Relay skill offer, made at most once per run. */
  offerSkill?: () => Promise<void>;
  connect?: Partial<Pick<import("./connect.js").ConnectDependencies, "sniff" | "runCommand" | "startCommand" | "observer" | "renderQR" | "pairTimeoutMs" | "version">>;
  terminalSession?: AgentSessionDependencies["session"];
  terminalIO?: AgentSessionDependencies["io"];
  terminalClient?: AgentSessionDependencies["client"];
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetch?: typeof fetch;
}

interface GlobalOptions {
  profile?: string;
  json?: boolean;
  nonInteractive?: boolean;
}

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
): MessageContent => ({
  parts: [{ type: "text", value: nonempty("Message text", text) }],
  ...(idempotencyKey
    ? { idempotency_key: nonempty("Idempotency key", idempotencyKey) }
    : {}),
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
  const configContext = dependencies.configContext ?? {};
  const resolveClient = dependencies.resolveClient
    ?? ((profile?: string) => createClientContext(profile, configContext));
  const output = (value: unknown): void => stdout(jsonText(value));
  const clientFor = async (command: Command): Promise<Relay> =>
    (await resolveClient(globals(command).profile)).client;

  const program = new Command()
    .name("relaymessenger")
    .description("The Relay command line tool: create an agent, sign in, and use Relay from a terminal.")
    .version(PACKAGE_VERSION)
    .option("--json", "print the result as JSON")
    .option("--non-interactive", "never show menus or ask questions")
    .option("--profile <name>", "which saved profile on this computer to use", (configContext.env ?? process.env).RELAY_PROFILE);
  program.exitOverride();
  program.configureOutput({
    writeOut: stdout,
    writeErr: stderr,
  });

  program.hook("preAction", async (_root, action) => {
    if (dependencies.beforeSetup && ((action.parent?.name() === "agents" && action.name() === "create")
      || (action.parent?.name() === "auth" && action.name() === "login"))) await dependencies.beforeSetup();
  });
  const agentDeps = dependencies.agents ?? agentDependencies(configContext, dependencies.fetch);
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

  program
    .command("connect")
    .argument("[runtime]", "what will answer as this agent: claude, hermes or openclaw")
    .description("connect an agent, new or by token, and prove it answers")
    .option("--new", "create a new agent instead of using one you already have")
    .option("--handle <handle>", "the .dev handle you want for a new agent; leave it out and Relay picks one")
    .option("--name <name>", "the name people see next to a new agent")
    .option("--image <path-or-url>", "a picture for a new agent: a file on this computer, or an https:// address")
    .option("--token <token>", "use an agent you already have, by its token")
    .option("--allow <handles>", "the handles allowed to message this agent, separated by commas; skips waiting for a first message")
    .option("--yes", "take the plan as it is, and replace a token already in the runtime's config")
    .option("--dry-run", "print the plan and change nothing")
    .option("--no-start", "do not start the runtime at the end; print its command instead")
    .option("--no-skill", "do not offer the Relay skill at the end")
    .option("--json", "print the result as JSON")
    .option("--api-url <url>", "the Relay API address to use", validateApiURL)
    .action(async (runtime: string | undefined, options: ConnectRunOptions, command: Command) => {
      const env = configContext.env ?? process.env;
      const home = configContext.home ?? homedir();
      await runConnect(runtime, { ...options, json: options.json === true || globals(command).json === true }, {
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
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.offerSkill ? { offerSkill: dependencies.offerSkill } : {}),
        ...dependencies.connect,
      });
    });

  const agents = program.command("agents").description("Create an agent, list the agents saved on this computer, and delete one.");
  connectOptions(agents.command("create"))
    .option("--api-url <url>", "the Relay API address to use", validateApiURL)
    .option("--token-name <name>", "a label for the new token, so you can tell it apart later")
    .option("--handle <handle>", "the .dev handle you want; leave it out and Relay picks one")
    .option("--name <name>", "the name people see next to this agent")
    .option("--image <path-or-url>", "a picture: a file on this computer, or an https:// address")
    .option("--image-url <url>", "a picture at an https:// address (same as --image with a URL)")
    .option("--image-recipe <json-file>", "a Relay picture recipe file; needs --image or --image-url as well")
    .option("--json", "print the result as JSON")
    .action(async (options: ConnectOptions & { apiUrl?: string; tokenName?: string; json?: boolean; handle?: string; name?: string; image?: string; imageUrl?: string; imageRecipe?: string }, command: Command) => {
      const target = await connectTarget(options);
      if (options.image !== undefined && options.imageUrl !== undefined) throw new Error("Choose --image or --image-url, not both.");
      const imageRecipe: AgentImageRecipe | undefined = options.imageRecipe === undefined
        ? undefined : await readImageRecipe(options.imageRecipe);
      const created = await createAgentWithPicture({
        ...(program.getOptionValueSource("profile") === "cli" && globals(command).profile ? { profile: globals(command).profile } : {}),
        ...(options.apiUrl ? { apiURL: options.apiUrl } : {}),
        ...(options.tokenName === undefined ? {} : { tokenName: options.tokenName }),
        ...(options.handle === undefined ? {} : { handle: options.handle }),
        ...(options.name === undefined ? {} : { firstName: options.name }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageUrl === undefined ? {} : { imageURL: options.imageUrl }),
        ...(imageRecipe === undefined ? {} : { imageRecipe }),
        ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
        ...(configContext.home ? { home: configContext.home } : {}),
      }, agentDeps, dependencies.fetch);
      const result = created.result;
      const imageUpdate = created.image;
      let connectResult;
      if (target) {
        try { connectResult = await connectAgentToRuntime(target, result.profile, agentDeps, { consent: options.confirmConfigure === true, runtimeStopped: options.runtimeStopped === true }, true); }
        catch { connectResult = { status: "required-action", code: "connect-failed", message: "The token is saved, but Relay could not write it into the runtime you chose. Run npx relaymessenger auth login --connect with the saved token; do not create another agent.", connected: false }; }
      }
      if (globals(command).json) output({ ...result, ...(imageUpdate ? { image: imageUpdate } : {}), ...(connectResult ? { connect: connectResult } : {}) });
      else {
        stdout(`${result.display_name} (@${result.handle})\nProfile: ${result.profile}\n${result.share_url}\nToken saved in ${configPath(configContext)}\n`);
        const liveViewFollows = imageUpdate?.status !== "incomplete" && (!connectResult || connectResult.status === "configured") && willShowSavedAgent(command);
        if (!liveViewFollows) {
          // The QR code holds the public link, never the token.
          try { stdout(renderTerminalQR(result.share_url)); }
          catch { stderr("Relay could not draw the QR code. Use the link above instead.\n"); }
        }
        if (imageUpdate?.status === "incomplete") output({ image: imageUpdate });
        if (connectResult) output({ connect: connectResult });
      }
      if (imageUpdate?.status !== "incomplete" && (!connectResult || connectResult.status === "configured")) {
        await showSavedAgent(command, { profile: result.profile, handle: result.handle, apiURL: result.api_url, shareURL: result.share_url,
          runtime: target ? { ownership: "external", connection: "unknown", label: target.runtime } : { ownership: "none", connection: "not-started" },
        });
      }
      if (imageUpdate?.status === "incomplete") {
        throw new Error(incompletePictureMessage(result.handle, result.profile, imageUpdate, imageRecipe !== undefined));
      }
      if (connectResult && connectResult.status !== "configured") throw new Error("The token is saved, but the runtime you chose still needs something from you. Read the message above, then run npx relaymessenger auth login --connect; do not create another agent.");
    });
  agents.command("list").option("--json", "print the result as JSON")
    .action(async () => output(await listAgents(agentDeps)));
  agents.command("delete").argument("<handle>", "agent handle", handle)
    .option("--json", "print the result as JSON")
    .action(async (agentHandle: string, _options: object, command: Command) => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmDelete && !await dependencies.confirmDelete()) throw new InteractiveCancelled();
      output(await deleteAgent(agentHandle, globals(command).profile, agentDeps));
    });

  const authCommands = program.command("auth").description("Save, check and remove the token this computer signs in with.");
  authCommands.configureOutput({
    outputError: (_message, write) => write("Those options are not right for auth. To sign in, pipe the token into npx relaymessenger auth login --with-token. Never type a token as an option value.\n"),
  });
  connectOptions(authCommands.command("login"))
    .description("Save a token for this computer. Relay asks for it in a hidden prompt, or reads it from a pipe, from RELAY_AGENT_TOKEN, or from the profile you name.")
    .option("--with-token", "read the token from a pipe instead of asking for it")
    .option("--api-url <url>", "the Relay API address this profile uses")
    .action(async (
      options: ConnectOptions & { withToken?: boolean; apiUrl?: string },
      command: Command,
    ) => {
      const target = await connectTarget(options);
      const env = configContext.env ?? process.env;
      const config = await readConfig(configContext);
      const profile = validateProfileName(globals(command).profile ?? config.current_profile);
      const previous = config.profiles[profile] ?? {};
      // An explicit --connect may reuse a saved profile without swapping in an
      // unrelated token from the environment. --with-token always reads the pipe.
      const reuseSaved = Boolean(target && previous.agent_token) && !options.withToken;
      let raw: string | undefined;
      if (options.withToken && !dependencies.readStdin && process.stdin.isTTY) {
        if (globals(command).nonInteractive || globals(command).json || dependencies.isInteractive === false) throw new Error("Nothing is piped in. Pipe the token into this command, for example: echo \"$RELAY_AGENT_TOKEN\" | npx relaymessenger auth login --with-token");
        raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
      } else if (options.withToken) {
        raw = await (dependencies.readStdin ?? (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks).toString("utf8");
        }))();
      } else if (reuseSaved) raw = previous.agent_token;
      else if (env.RELAY_AGENT_TOKEN !== undefined) raw = env.RELAY_AGENT_TOKEN;
      else {
        const interactive = !globals(command).nonInteractive && !globals(command).json && (dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY));
        if (!interactive) throw new Error("Relay has no token and cannot ask for one here. Pipe it into npx relaymessenger auth login --with-token, or set RELAY_AGENT_TOKEN.");
        raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
      }
      if (!raw) throw new Error("No token was given, so nothing was changed.");
      const token = validateToken(raw);
      const apiURL = validateApiURL(options.apiUrl ?? (reuseSaved ? previous.api_url : env.RELAY_API_URL ?? previous.api_url) ?? defaultCreationApiURL());
      {
        try {
          const cards = await agentDeps.client(token, apiURL).contactCard.retrieve();
          if (cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active).length !== 1) throw new Error("This token must belong to exactly one active agent.");
        } catch { throw new Error("Relay would not accept this token. Nothing was changed: your saved token and your runtime configuration are as they were."); }
      }
      config.profiles[profile] = { api_url: apiURL, agent_token: token };
      await writeConfig(config, configContext);
      const connectResult = target ? await connectAgentToRuntime(target, profile, agentDeps, { consent: options.confirmConfigure === true, runtimeStopped: options.runtimeStopped === true }, true) : undefined;
      output(safeMetadata({ ok: true, profile, api_url: apiURL, token: "stored", ...(connectResult ? { connect: connectResult } : {}) }, [token]));
      if (!connectResult || connectResult.status === "configured") await showSavedAgent(command, { profile, apiURL,
        runtime: { ownership: target ? "external" : "unknown", connection: "unknown", ...(target ? { label: target.runtime } : {}) },
      });
      if (connectResult && connectResult.status !== "configured") throw new Error("The token is saved, but the runtime you chose still needs something from you. Read the message above.");
    });
  authCommands
    .command("status")
    .description("Show which token Relay would use, and where it comes from, without printing it.")
    .action(async (_options: object, command: Command) => {
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
    });
  authCommands
    .command("logout")
    .description("Remove the selected profile's stored token.")
    .action(async (_options: object, command: Command) => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmLogout && !await dependencies.confirmLogout()) throw new InteractiveCancelled();
      const config = await readConfig(configContext);
      const profile = validateProfileName(
        globals(command).profile ?? config.current_profile,
      );
      const selected = config.profiles[profile];
      if (!selected) throw new Error(`Relay profile ${profile} does not exist.`);
      const { agent_token: _removed, ...withoutToken } = selected;
      config.profiles[profile] = withoutToken;
      await writeConfig(config, configContext);
      output({ ok: true, profile, token: "removed" });
    });

  const profiles = program.command("profiles").description("Manage local Relay profiles.");
  profiles
    .command("add")
    .argument("<name>", "profile name", validateProfileName)
    .requiredOption("--api-url <url>", "the Relay API address this profile uses", validateApiURL)
    .description("Add a profile without storing a token.")
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
    .description("Select the default local profile.")
    .action(async (name: string) => {
      const config = await readConfig(configContext);
      if (!config.profiles[name]) throw new Error(`Relay profile ${name} does not exist.`);
      config.current_profile = name;
      await writeConfig(config, configContext);
      output({ ok: true, current_profile: name });
    });
  profiles
    .command("remove")
    .argument("<name>", "profile name", validateProfileName)
    .description("Remove a non-current profile and its token.")
    .action(async (name: string) => {
      const config = await readConfig(configContext);
      if (name === config.current_profile) {
        throw new Error("Cannot remove the current profile; select another first.");
      }
      if (!config.profiles[name]) throw new Error(`Relay profile ${name} does not exist.`);
      delete config.profiles[name];
      await writeConfig(config, configContext);
      output({ ok: true, removed: name });
    });
  profiles
    .command("list")
    .description("List profiles without revealing tokens.")
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
    .command("config-path")
    .description("Print the local Relay config path.")
    .action(() => output({ path: configPath(configContext) }));

  program
    .command("doctor")
    .description("Check this computer: Node.js, the saved token, file permissions, the installed Relay package, and whether Relay answers.")
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
          }),
        },
      );
      output(report);
      if (!report.ok) throw new Error("Some checks did not pass. Each line above says what to fix.");
    });

  const chats = program.command("chats").description(
    "Read and update chats. To start or join a chat that includes a person, every agent in it must already be one of that person's contacts and not blocked. "
    + "Chats between agents only need no such contact.",
  );
  chats
    .command("list")
    .option("--cursor <cursor>")
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
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.retrieve(chatID)));
  chats
    .command("create")
    .description("Create a Chat with at most 7 total participants, including the sender.")
    .requiredOption("--from <handle>", "sender Handle", handle)
    .requiredOption("--to <handles...>", "at most 6 recipient Handles", (value) => handle(value))
    .requiredOption("--text <text>")
    .requiredOption("--idempotency-key <key>")
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
    .argument("<chat-id>")
    .option("--display-name <name>")
    .option("--group-icon <attachment-id-or-https-url>")
    .option("--clear-group-icon")
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
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.leaveChat(chatID)));
  chats
    .command("read")
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.markAsRead(chatID);
      output(voidResult);
    });

  const typing = chats.command("typing").description("Manage Chat typing state.");
  typing
    .command("start")
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.startTyping(chatID);
      output(voidResult);
    });
  typing
    .command("stop")
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.stopTyping(chatID);
      output(voidResult);
    });

  const participants = chats.command("participants")
    .description(
      "Add or remove agents in a chat. In a chat that includes a person, the agent you add and the agent doing the adding must both be that person's contacts and not blocked. "
      + "The same holds for an agent that removes another. An agent may always leave a chat itself.",
    );
  participants
    .command("add")
    .argument("<chat-id>")
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
    .argument("<chat-id>")
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

  const chatMessages = chats.command("messages").description("Read and send Chat Messages.");
  chatMessages
    .command("list")
    .argument("<chat-id>")
    .option("--cursor <cursor>")
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
    .argument("<chat-id>")
    .requiredOption("--text <text>")
    .requiredOption("--idempotency-key <key>")
    .action(async (
      chatID: string,
      options: { text: string; idempotencyKey: string },
      command: Command,
    ) => {
      const body = {
        message: textContent(options.text, options.idempotencyKey),
      } satisfies MessageSendParams;
      output(await (await clientFor(command)).chats.messages.send(chatID, body));
    });

  chats
    .command("voice-memo")
    .argument("<chat-id>")
    .option("--attachment-id <id>")
    .option("--url <url>")
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

  const messages = program.command("messages").description("Read, send, and react to Messages.");
  messages
    .command("send")
    .requiredOption("--to <handles...>", "at most 6 recipient Handles", (value) => handle(value))
    .requiredOption("--text <text>")
    .requiredOption("--idempotency-key <key>")
    .action(async (
      options: { to: string[]; text: string; idempotencyKey: string },
      command: Command,
    ) => {
      if (options.to.length > 6) throw new Error("A Chat accepts at most 6 recipient Handles (7 total participants).");
      const body = {
        to: options.to,
        message: textContent(options.text, options.idempotencyKey),
      } satisfies MessageCreateParams;
      output(await (await clientFor(command)).messages.create(body));
    });
  messages
    .command("get")
    .argument("<message-id>")
    .action(async (messageID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).messages.retrieve(messageID)));
  messages
    .command("thread")
    .argument("<message-id>")
    .option("--cursor <cursor>")
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
    .argument("<message-id>")
    .requiredOption("--operation <operation>", "add or remove")
    .requiredOption("--type <type>")
    .option("--custom-emoji <emoji>")
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

  const attachments = program.command("attachments").description("Upload files to Relay, and read or delete the ones you uploaded.");
  attachments
    .command("allocate")
    .requiredOption("--filename <name>")
    .requiredOption("--content-type <type>")
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
    .argument("<file>")
    .requiredOption("--content-type <type>")
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
    .argument("<attachment-id>")
    .action(async (attachmentID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).attachments.retrieve(attachmentID)));
  attachments
    .command("delete")
    .argument("<attachment-id>")
    .action(async (attachmentID: string, _options: object, command: Command) => {
      await (await clientFor(command)).attachments.delete(attachmentID);
      output(voidResult);
    });

  const blocked = program.command("blocked-handles").description("Manage blocked Handles.");
  blocked
    .command("list")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).blockedHandles.list()));
  blocked
    .command("add")
    .argument("<handle>", "Handle", handle)
    .option("--reason <reason>")
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

  const webhooks = program.command("webhooks").description("List the event types Relay can send, and manage where it sends them.");
  webhooks
    .command("events")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookEvents.list()));
  program
    .command("events")
    .description("Watch the events Relay sends to an agent, live.")
    .command("listen")
    .option("--forward-to <url>", "also POST each event to this address on your own computer (localhost only)")
    .requiredOption(
      "--acknowledge-events",
      "yes: this agent is a test agent, and reading events here may make Relay stop resending them elsewhere",
    )
    .description("Print each event as it arrives, and optionally send a copy to your own computer. Copies are not signed.")
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
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        await listenForAgentEvents(
          context.client,
          {
            ...(options.forwardTo ? { forwardTo: options.forwardTo } : {}),
            signal: controller.signal,
            ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          },
          { stdout, stderr },
        );
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    });

  const subscriptions = webhooks.command("subscriptions").description("Manage webhook subscriptions.");
  subscriptions
    .command("list")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookSubscriptions.list()));
  subscriptions
    .command("get")
    .argument("<subscription-id>")
    .action(async (subscriptionID: string, _options: object, command: Command) =>
      output(
        await (await clientFor(command)).webhookSubscriptions.retrieve(
          subscriptionID,
        ),
      ));
  subscriptions
    .command("create")
    .requiredOption("--target-url <url>")
    .requiredOption("--event <events...>")
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
    .argument("<subscription-id>")
    .option("--target-url <url>")
    .option("--event <events...>")
    .option("--active")
    .option("--inactive")
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
    .argument("<subscription-id>")
    .action(async (subscriptionID: string, _options: object, command: Command) => {
      await (await clientFor(command)).webhookSubscriptions.delete(subscriptionID);
      output(voidResult);
    });

  const contactCard = program.command("contact-card").description("Set the name and picture people see for this agent, and share it into a chat.");
  contactCard
    .command("get")
    .option("--handle <handle>", "the agent's handle", handle)
    .action(async (options: { handle?: string }, command: Command) =>
      output(await (await clientFor(command)).contactCard.retrieve(options)));
  contactCard
    .command("setup")
    .requiredOption("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the name people see next to this agent")
    .addOption(new Option("--first-name <name>").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--image-url <url>", "a picture at an https:// address")
    .action(async (
      options: {
        handle: string;
        name?: string;
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
    .requiredOption("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the name people see next to this agent")
    .addOption(new Option("--first-name <name>").hideHelp())
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
        name?: string;
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
    .description("Share this agent's name and picture into a chat.")
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.shareContactCard(chatID);
      output(voidResult);
    });

  program
    .command("contact-requests")
    .description("Ask a person to add this agent. Only agents on a paid handle may ask; others get an error saying so.")
    .command("create")
    .argument("<handle>", "the person's handle", handle)
    .action(async (
      contactHandle: string,
      _options: object,
      command: Command,
    ) => output(
      await (await clientFor(command)).contactRequests.create({
        handle: contactHandle,
      }),
    ));

  return program;
};

export const runCLI = async (
  argv: string[],
  dependencies: ProgramDependencies = {},
): Promise<number> => {
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const env = dependencies.configContext?.env ?? process.env;
  const interactive = interactiveAllowed(argv, dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY));
  const ui = interactive ? dependencies.prompts ?? clackPrompts((message) => stderr(`${message}\n`)) : undefined;
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
      if (!await ui.confirm("Install the Relay skill? The installer will ask which coding agents to install it for, and whether to install it for this folder or for you everywhere.")) return 0;
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
    const entry = interactiveEntry(argv);
    if (ui && entry) {
      const selected = await chooseInteractiveCommand(entry.entry, entry.prefix, agentDeps, ui, async () => { await skillOffer(); });
      if (!selected) return 0;
      if (selected === "install-skill") return await skillOffer(true);
      args = selected;
    } else if (entry) args = [...argv, "--help"];
    await createProgram({
      ...dependencies, agents: agentDeps, isInteractive: interactive,
      ...(ui ? {
        prompts: ui,
        beforeSetup: async () => { await skillOffer(); },
        offerSkill: async () => { await skillOffer(); },
        readSecret: dependencies.readSecret ?? (() => ui.password("Paste your token")),
        confirmDelete: () => ui.confirm("Delete the selected agent? This cannot be undone."),
        confirmLogout: () => ui.confirm("Remove the saved token from this computer? The agent itself is not deleted."),
      } : {}),
    }).parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof InteractiveCancelled) { stderr("Cancelled.\n"); return 0; }
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed"
        || error.code === "commander.version"
      ) {
        return 0;
      }
      return error.exitCode;
    }
    let secrets: string[] = [];
    try {
      secrets = await collectConfiguredTokens(dependencies.configContext);
    } catch {
      const env = dependencies.configContext?.env ?? process.env;
      if (env.RELAY_AGENT_TOKEN) secrets = [env.RELAY_AGENT_TOKEN];
    }
    const message = errorText(error, secrets);
    // A question that cannot be asked is not a crash: name the flags that would
    // have answered it and exit 2, the way Stripe and eas do.
    const headless = error instanceof HeadlessPrompt;
    const nextStep = headless
      ? (error as HeadlessPrompt).nextStep
      : error instanceof ConnectFailure
      ? errorText(new Error(error.nextStep), secrets)
      : "Run  npx relaymessenger doctor  to check this computer.";
    if (argv.includes("--json")) {
      stderr(`${jsonText({ error: message, next_step: nextStep })}`);
      return headless ? 2 : 1;
    }
    if (headless) {
      stderr(`Error: ${message}\nThere is no terminal here, so nothing was asked. Pass one of these instead:\n${(error as HeadlessPrompt).flags.map((flag) => `  ${flag}`).join("\n")}\n`);
      return 2;
    }
    stderr(`Error: ${message}\n`);
    return 1;
  }
};
