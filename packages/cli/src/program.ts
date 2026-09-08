import { homedir } from "node:os";
import { clackPrompts, chooseInteractiveCommand, interactiveAllowed, interactiveEntry, InteractiveCancelled, type InteractivePrompts } from "./interactive.js";
import { installRelaySkill, relaySkillPresent } from "./skill-offer.js";
import { readHiddenToken } from "./secret-input.js";
import { handoffAgent, handoffOptions, handoffTarget, type HandoffOptions } from "./agent-handoff.js";
import { agentDependencies, createAgent, deleteAgent, listAgents, type AgentDependencies } from "./agents.js";
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
    .description("Official CLI for Relay v1 Agent resources.")
    .version(PACKAGE_VERSION)
    .option("--json", "machine-readable output; disables optional prompts")
    .option("--non-interactive", "disable menus and optional prompts")
    .option("--profile <name>", "local Relay profile", (configContext.env ?? process.env).RELAY_PROFILE);
  program.exitOverride();
  program.configureOutput({
    writeOut: stdout,
    writeErr: stderr,
  });

  const agentDeps = dependencies.agents ?? agentDependencies(configContext, dependencies.fetch);
  const agents = program.command("agents").description("Create, inspect local profiles, and delete developer-managed agents.");
  handoffOptions(agents.command("create"))
    .option("--api-url <url>", "Relay API origin", validateApiURL)
    .option("--token-name <name>", "label for the new Agent Token")
    .option("--handle <handle>", "optional full .dev handle; omission keeps server assignment")
    .option("--name <name>", "optional display name")
    .option("--image-url <url>", "public HTTPS image to copy into Relay storage")
    .option("--image-recipe <json-file>", "existing Relay recipe JSON; requires its rendered --image-url")
    .option("--json", "print safe metadata as JSON")
    .action(async (options: HandoffOptions & { apiUrl?: string; tokenName?: string; json?: boolean; handle?: string; name?: string; imageUrl?: string; imageRecipe?: string }, command: Command) => {
      const target = await handoffTarget(options);
      let imageRecipe: AgentImageRecipe | undefined;
      if (options.imageRecipe !== undefined) {
        if (options.imageUrl === undefined) throw new Error("--image-recipe requires the rendered --image-url.");
        try {
          const info = await stat(options.imageRecipe);
          if (!info.isFile() || info.size > 8192) throw new Error("Invalid recipe file.");
          const raw = await readFile(options.imageRecipe, "utf8");
          if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Recipe too large.");
          const value: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipe must be an object.");
          imageRecipe = value as AgentImageRecipe; // Server's existing recipe parser remains authoritative.
        } catch { throw new Error("Image recipe must be a readable JSON object file no larger than 8192 bytes."); }
      }
      const result = await createAgent({
        ...(program.getOptionValueSource("profile") === "cli" && globals(command).profile ? { profile: globals(command).profile } : {}),
        ...(options.apiUrl ? { apiURL: options.apiUrl } : {}),
        ...(options.tokenName === undefined ? {} : { tokenName: options.tokenName }),
        ...(options.handle === undefined ? {} : { handle: options.handle }),
        ...(options.name === undefined ? {} : { firstName: options.name }),
        ...(options.imageUrl === undefined ? {} : { imageURL: options.imageUrl }),
        ...(imageRecipe === undefined ? {} : { imageRecipe }),
      }, agentDeps);
      let handoff;
      if (target) {
        try { handoff = await handoffAgent(target, result.profile, agentDeps, { consent: options.confirmConfigure === true, runtimeStopped: options.runtimeStopped === true }, true); }
        catch { handoff = { status: "required-action", code: "handoff-failed", message: "Agent credential is stored; runtime handoff failed. Use auth login --connect with the stored credential; do not create another agent.", connected: false }; }
      }
      if (globals(command).json) output({ ...result, ...(handoff ? { handoff } : {}) });
      else {
        stdout(`${result.agent.first_name} (@${result.agent.handle})\nProfile: ${result.profile}\n${result.share_url}\nToken: stored\n`);
        // Load only for human output; the QR encodes the public share URL, not credentials.
        const qr = createRequire(import.meta.url)("qrcode") as {
          toString(text: string, options: { type: "terminal"; small: boolean }): Promise<string>;
        };
        try { stdout(await qr.toString(result.share_url, { type: "terminal", small: true })); }
        catch { stderr("QR rendering unavailable; use the share link above.\n"); }
        if (handoff) output({ handoff });
      }
      if (handoff && handoff.status !== "configured") throw new Error("Agent credential is stored; runtime handoff requires action. Use auth login --connect rather than creating again.");
    });
  agents.command("list").option("--json", "print safe metadata as JSON")
    .action(async () => output(await listAgents(agentDeps)));
  agents.command("delete").argument("<handle>", "agent handle", handle)
    .option("--json", "print safe metadata as JSON")
    .action(async (agentHandle: string, _options: object, command: Command) => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmDelete && !await dependencies.confirmDelete()) throw new InteractiveCancelled();
      output(await deleteAgent(agentHandle, globals(command).profile, agentDeps));
    });

  const authCommands = program.command("auth").description("Manage Agent Token authentication.");
  authCommands.configureOutput({
    outputError: (_message, write) => write("Invalid auth arguments. Use auth login --with-token with stdin; never put a token in an argument.\n"),
  });
  handoffOptions(authCommands.command("login"))
    .description("Save an Agent Token using a hidden prompt, stdin, environment, or selected handoff profile.")
    .option("--with-token", "read the token from stdin")
    .option("--api-url <url>", "set the profile API origin")
    .action(async (
      options: HandoffOptions & { withToken?: boolean; apiUrl?: string },
      command: Command,
    ) => {
      const target = await handoffTarget(options);
      const env = configContext.env ?? process.env;
      const config = await readConfig(configContext);
      const profile = validateProfileName(globals(command).profile ?? config.current_profile);
      const previous = config.profiles[profile] ?? {};
      // Explicit --connect can reuse a saved profile without substituting an
      // unrelated environment token. --with-token always selects stdin.
      const reuseSaved = Boolean(target && previous.agent_token) && !options.withToken;
      let raw: string | undefined;
      if (options.withToken && !dependencies.readStdin && process.stdin.isTTY) {
        if (globals(command).nonInteractive || globals(command).json || dependencies.isInteractive === false) throw new Error("Use redirected stdin with --with-token in non-interactive mode.");
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
        if (!interactive) throw new Error("No Agent Token available in non-interactive mode. Use auth login --with-token with stdin or RELAY_AGENT_TOKEN.");
        raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
      }
      if (!raw) throw new Error("No Agent Token was supplied; no credentials were changed.");
      const token = validateToken(raw);
      const apiURL = validateApiURL(options.apiUrl ?? (reuseSaved ? previous.api_url : env.RELAY_API_URL ?? previous.api_url) ?? defaultCreationApiURL());
      {
        try {
          const cards = await agentDeps.client(token, apiURL).contactCard.retrieve();
          if (cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active).length !== 1) throw new Error("Agent credential required.");
        } catch { throw new Error("Agent Token validation failed; existing credentials and runtime configuration were kept."); }
      }
      config.profiles[profile] = { api_url: apiURL, agent_token: token };
      await writeConfig(config, configContext);
      const handoff = target ? await handoffAgent(target, profile, agentDeps, { consent: options.confirmConfigure === true, runtimeStopped: options.runtimeStopped === true }, true) : undefined;
      output(safeMetadata({ ok: true, profile, api_url: apiURL, token: "stored", ...(handoff ? { handoff } : {}) }, [token]));
      if (handoff && handoff.status !== "configured") throw new Error("Token is stored; native runtime configuration requires action.");
    });
  authCommands
    .command("status")
    .description("Show token resolution without revealing the token.")
    .action(async (_options: object, command: Command) => {
      const resolved = await resolveAuth(globals(command).profile, configContext);
      output({
        configured: true,
        profile: resolved.profile,
        api_url: resolved.apiURL,
        token_source: resolved.tokenSource,
        config_path: resolved.configPath,
      });
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
    .requiredOption("--api-url <url>", "Relay API origin", validateApiURL)
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
    .description("Check runtime, token configuration, config security, SDK contract, and API.")
    .option("--offline", "skip the read-only API request")
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
      if (!report.ok) throw new Error("Relay doctor found failing checks.");
    });

  const chats = program.command("chats").description(
    "Read and update Chats. Agents and users have the same generic Chat API permissions. "
    + "Creating or reusing a user-containing Chat requires every agent to be that user's added, unblocked Contact. "
    + "Agent-only messaging keeps its existing behavior.",
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
      if (Object.keys(body).length === 0) throw new Error("No Chat update was provided.");
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
      "Manage Chat participants; selectable participants are agents. "
      + "In user-containing Chats, a new agent and any acting agent must be the user's added, unblocked Contacts. "
      + "An agent removing others must still be an added, unblocked Contact; self-leave keeps existing rules.",
    );
  participants
    .command("add")
    .argument("<chat-id>")
    .argument("<handle>", "participant Handle", handle)
    .option("--hide-history", "hide history before the new membership (server default)")
    .option("--no-hide-history", "share earlier retained history")
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
    .option("--part-index <number>", "zero-based part index", integer)
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
      if (!operations.has(options.operation)) throw new Error("Invalid reaction operation.");
      if (!types.has(options.type)) throw new Error("Invalid reaction type.");
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

  const attachments = program.command("attachments").description("Allocate, upload, and manage Attachments.");
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

  const webhooks = program.command("webhooks").description("Read and manage Webhook metadata.");
  webhooks
    .command("events")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookEvents.list()));
  program
    .command("events")
    .description("Receive acknowledged Agent events over WebSocket.")
    .command("listen")
    .option("--forward-to <loopback-url>")
    .requiredOption(
      "--acknowledge-events",
      "confirm that this dedicated non-production Agent may advance its checkpoint",
    )
    .description("Print Agent events or forward them unsigned to loopback.")
    .action(async (
      options: { forwardTo?: string; acknowledgeEvents: boolean },
      command: Command,
    ) => {
      const requestedProfile = globals(command).profile;
      if (!requestedProfile) {
        throw new Error(
          "Agent event listening requires an explicit --profile for a dedicated non-production Agent.",
        );
      }
      const context = await resolveClient(requestedProfile);
      if (context.auth.apiURL === DEFAULT_API_URL) {
        throw new Error(
          "Agent event listening refuses the production Relay API origin.",
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
        throw new Error("No webhook subscription update was provided.");
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

  const contactCard = program.command("contact-card").description("Configure and share the Agent Contact Card.");
  contactCard
    .command("get")
    .option("--handle <handle>", "Agent Handle", handle)
    .action(async (options: { handle?: string }, command: Command) =>
      output(await (await clientFor(command)).contactCard.retrieve(options)));
  contactCard
    .command("setup")
    .requiredOption("--handle <handle>", "Agent Handle", handle)
    .requiredOption("--first-name <name>")
    .option("--last-name <name>")
    .option("--image-url <url>")
    .action(async (
      options: {
        handle: string;
        firstName: string;
        lastName?: string;
        imageUrl?: string;
      },
      command: Command,
    ) => {
      const body = {
        handle: options.handle,
        first_name: nonempty("First name", options.firstName),
        ...(options.lastName ? { last_name: options.lastName } : {}),
        ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
      } satisfies ContactCardCreateParams;
      output(await (await clientFor(command)).contactCard.create(body));
    });
  contactCard
    .command("update")
    .requiredOption("--handle <handle>", "Agent Handle", handle)
    .option("--first-name <name>")
    .option("--last-name <name>")
    .option("--clear-last-name")
    .option("--image-url <url>")
    .option("--clear-image-url")
    .action(async (
      options: {
        handle: string;
        firstName?: string;
        lastName?: string;
        clearLastName?: boolean;
        imageUrl?: string;
        clearImageUrl?: boolean;
      },
      command: Command,
    ) => {
      if (options.lastName && options.clearLastName) {
        throw new Error("Choose --last-name or --clear-last-name, not both.");
      }
      if (options.imageUrl && options.clearImageUrl) {
        throw new Error("Choose --image-url or --clear-image-url, not both.");
      }
      const body = {
        handle: options.handle,
        ...(options.firstName ? { first_name: options.firstName } : {}),
        ...(options.lastName
          ? { last_name: options.lastName }
          : options.clearLastName
          ? { last_name: null }
          : {}),
        ...(options.imageUrl
          ? { image_url: options.imageUrl }
          : options.clearImageUrl
          ? { image_url: null }
          : {}),
      } satisfies ContactCardUpdateParams;
      if (Object.keys(body).length === 1) {
        throw new Error("No Contact Card update was provided.");
      }
      output(await (await clientFor(command)).contactCard.update(body));
    });
  contactCard
    .command("share")
    .description("Share the authenticated Agent's configured Contact Card.")
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.shareContactCard(chatID);
      output(voidResult);
    });

  program
    .command("contact-requests")
    .description("Ask a user to add the authenticated Premium Handle Agent.")
    .command("create")
    .argument("<handle>", "user Handle", handle)
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
  const interactive = interactiveAllowed(argv, env, dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY));
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
      if (!await ui.confirm("Install the Relay skill? The standard installer will ask you to choose agents and project/global scope.")) return 0;
      try {
        await (dependencies.skillInstaller ?? (() => installRelaySkill(cwd, env)))();
        inform("The standard skill installer finished.");
        return 0;
      } catch {
        inform("Skill installation did not complete. Existing agent and credential results are unchanged.");
        return force ? 1 : 0;
      }
    } catch (error) {
      inform("Skill offer dismissed. Existing agent and credential results are unchanged.");
      return error instanceof InteractiveCancelled ? 0 : force ? 1 : 0;
    }
  };
  try {
    let args = argv;
    const entry = interactiveEntry(argv);
    if (ui && entry) {
      const selected = await chooseInteractiveCommand(entry.entry, entry.prefix, agentDeps, ui);
      if (!selected) return 0;
      if (selected === "install-skill") return await skillOffer(true);
      args = selected;
    } else if (entry) args = [...argv, "--help"];
    await createProgram({
      ...dependencies, agents: agentDeps, isInteractive: interactive,
      ...(ui ? {
        readSecret: dependencies.readSecret ?? (() => ui.password("Agent Token")),
        confirmDelete: () => ui.confirm("Delete the selected agent? This cannot be undone."),
        confirmLogout: () => ui.confirm("Remove the selected stored token? The agent identity will not be deleted."),
      } : {}),
    }).parseAsync(args, { from: "user" });
    await skillOffer();
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
    stderr(`Error: ${errorText(error, secrets)}\n`);
    return 1;
  }
};
