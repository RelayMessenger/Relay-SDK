import type {
  ChatCreateParams,
  ChatSendVoicememoParams,
  ChatSetActivityParams,
  ChatUpdateParams,
  DirectorySearchParams,
  MessageSendParams,
} from "@relaymessenger/sdk";
import { Command, Option } from "commander";
import { HELP_GROUPS } from "../help-groups.js";
import {
  messageContent,
  messagePartOptions,
  type MessagePartOptions,
} from "../message-parts.js";
import {
  handle,
  idempotencyKeyOrNew,
  nonempty,
  positiveInteger,
  recipients,
  voidResult,
  type CommandContext,
} from "./context.js";

export const registerChatsCommands = (program: Command, ctx: CommandContext): void => {
  const { output, clientFor } = ctx;

  const directory = program.command("directory", { hidden: true })
    .helpGroup(HELP_GROUPS.everythingElse).description("find public agents");
  directory.command("search")
    .description("find agents by need or category")
    .option("--q <text>", "what you need done")
    .option("--category <category>", "filter by agent category")
    .option("--limit <number>", "maximum number of agents", positiveInteger)
    .addOption(new Option("--sort <order>", "sort by name or newest").choices(["name", "newest"]))
    .action(async (options: DirectorySearchParams, command: Command) =>
      output(await (await clientFor(command)).directory.search(options)));

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
  messagePartOptions(chats
    .command("create")
    .description("create a chat with up to 7 participants")
    .requiredOption("--from <handle>", "sender handle", handle))
    .requiredOption("--to <handles...>", "up to six recipients, repeated or comma-separated", recipients)
    .requiredOption("--idempotency-key <key>", "duplicate-send prevention key")
    .action(async (
      options: MessagePartOptions & { from: string; to: string[]; idempotencyKey: string },
      command: Command,
    ) => {
      if (options.to.length > 6) throw new Error("A Chat accepts at most 6 recipient Handles (7 total participants).");
      const body = {
        from: options.from,
        to: options.to,
        message: messageContent(options, nonempty("Idempotency key", options.idempotencyKey)),
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

  const location = chats.command("location").description("ask for and read a person's live location");
  location
    .command("request")
    .description("ask the person in a chat to share location")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.location.request(chatID)));
  location
    .command("get")
    .description("read the location shared in a chat")
    .argument("<chat-id>", "the chat ID")
    .action(async (chatID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).chats.location.retrieve(chatID)));

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
  messagePartOptions(chatMessages
    .command("send")
    .description("send a message to a chat")
    .argument("<chat-id>", "the chat ID"))
    .option("--idempotency-key <key>", "duplicate-send prevention key")
    .option("--silent", "delivery without a banner or sound")
    .action(async (
      chatID: string,
      options: MessagePartOptions & { idempotencyKey?: string; silent?: boolean },
      command: Command,
    ) => {
      const body = {
        message: messageContent(options, idempotencyKeyOrNew(options.idempotencyKey), options.silent),
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
};
