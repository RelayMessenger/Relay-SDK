import { readFile, stat } from "node:fs/promises";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
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
import { errorText, jsonText } from "./output.js";
import { listenForAgentEvents } from "./event-listen.js";

export interface ProgramDependencies {
  configContext?: ConfigContext;
  resolveClient?: (profile?: string) => Promise<ClientContext>;
  readStdin?: () => Promise<string>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetch?: typeof fetch;
}

interface GlobalOptions {
  profile?: string;
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
    .name("relay")
    .description("Official CLI for Relay v1 Agent resources.")
    .version("0.5.0-staging.4")
    .option("--profile <name>", "local Relay profile", process.env.RELAY_PROFILE);
  program.exitOverride();
  program.configureOutput({
    writeOut: stdout,
    writeErr: stderr,
  });

  const auth = program.command("auth").description("Manage local Agent Token authentication.");
  auth
    .command("login")
    .description("Store an Agent Token from stdin or RELAY_AGENT_TOKEN.")
    .option("--token-stdin", "read the token from stdin")
    .option("--from-env", "read the token from RELAY_AGENT_TOKEN")
    .option("--api-url <url>", "set the profile API origin")
    .action(async (
      options: { tokenStdin?: boolean; fromEnv?: boolean; apiUrl?: string },
      command: Command,
    ) => {
      if (options.tokenStdin === options.fromEnv) {
        throw new Error("Choose exactly one of --token-stdin or --from-env.");
      }
      const env = configContext.env ?? process.env;
      const raw = options.fromEnv
        ? env.RELAY_AGENT_TOKEN
        : await (dependencies.readStdin
          ?? (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
            return Buffer.concat(chunks).toString("utf8");
          }))();
      if (!raw) throw new Error("RELAY_AGENT_TOKEN is not set.");
      const token = validateToken(raw);
      const config = await readConfig(configContext);
      const profile = validateProfileName(
        globals(command).profile ?? config.current_profile,
      );
      const previous = config.profiles[profile] ?? {};
      config.profiles[profile] = {
        api_url: validateApiURL(
          options.apiUrl ?? previous.api_url ?? DEFAULT_API_URL,
        ),
        agent_token: token,
      };
      await writeConfig(config, configContext);
      output({
        ok: true,
        profile,
        api_url: config.profiles[profile].api_url,
        token: "stored",
      });
    });
  auth
    .command("status")
    .description("Show token resolution without revealing the token.")
    .action(async (_options: object, command: Command) => {
      const resolved = await resolveAuth(globals(command).profile, configContext);
      output({
        authenticated: true,
        profile: resolved.profile,
        api_url: resolved.apiURL,
        token_source: resolved.tokenSource,
        config_path: resolved.configPath,
      });
    });
  auth
    .command("logout")
    .description("Remove the selected profile's stored token.")
    .action(async (_options: object, command: Command) => {
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
    .description("Check runtime, auth, config security, SDK contract, and API.")
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

  const chats = program.command("chats").description("Read and update Chats.");
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
    .requiredOption("--from <handle>", "sender Handle", handle)
    .requiredOption("--to <handles...>", "recipient Handles", (value) => handle(value))
    .requiredOption("--text <text>")
    .requiredOption("--idempotency-key <key>")
    .action(async (
      options: { from: string; to: string[]; text: string; idempotencyKey: string },
      command: Command,
    ) => {
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

  const participants = chats.command("participants").description("Manage Chat participants.");
  participants
    .command("add")
    .argument("<chat-id>")
    .argument("<handle>", "participant Handle", handle)
    .action(async (
      chatID: string,
      participantHandle: string,
      _options: object,
      command: Command,
    ) => output(
      await (await clientFor(command)).chats.participants.add(
        chatID,
        { handle: participantHandle },
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
    .action(async (
      chatID: string,
      options: { cursor?: string; limit?: number },
      command: Command,
    ) => {
      const page = await (await clientFor(command)).chats.messages.list(
        chatID,
        options,
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
    .requiredOption("--to <handles...>", "recipient Handles", (value) => handle(value))
    .requiredOption("--text <text>")
    .requiredOption("--idempotency-key <key>")
    .action(async (
      options: { to: string[]; text: string; idempotencyKey: string },
      command: Command,
    ) => {
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
    .argument("<chat-id>")
    .action(async (chatID: string, _options: object, command: Command) => {
      await (await clientFor(command)).chats.shareContactCard(chatID);
      output(voidResult);
    });

  program
    .command("contact-requests")
    .description("Create a Contact request.")
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
  try {
    await createProgram(dependencies).parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
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
