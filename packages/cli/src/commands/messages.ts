import { readFile, stat } from "node:fs/promises";
import type {
  ContactLookupParams,
  MessageAddReactionParams,
  MessageCreateParams,
  PaymentCategory,
  PaymentMode,
  PaymentRequestCreateParams,
  PaymentStatus,
  SupportedContentType,
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
  integer,
  nonempty,
  positiveInteger,
  recipients,
  voidResult,
  type CommandContext,
} from "./context.js";

export const registerMessagesCommands = (program: Command, ctx: CommandContext): void => {
  const { output, clientFor } = ctx;

  const messages = program.command("messages", { hidden: true }).description("read, send and react to messages").helpGroup(HELP_GROUPS.everythingElse);
  messagePartOptions(messages
    .command("send")
    .description("send a message to the handles you name")
    .requiredOption("--to <handles...>", "up to six recipients, repeated or comma-separated", recipients))
    .option("--idempotency-key <key>", "duplicate-send prevention key")
    .option("--silent", "delivery without a banner or sound")
    .action(async (
      options: MessagePartOptions & { to: string[]; idempotencyKey?: string; silent?: boolean },
      command: Command,
    ) => {
      if (options.to.length > 6) throw new Error("A Chat accepts at most 6 recipient Handles (7 total participants).");
      const body = {
        to: options.to,
        message: messageContent(options, idempotencyKeyOrNew(options.idempotencyKey), options.silent),
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

  const payments = program.command("payment-requests", { hidden: true }).description("ask people to pay and track the requests").helpGroup(HELP_GROUPS.everythingElse);
  payments
    .command("create")
    .description("create a payment request to send as a card")
    .requiredOption("--description <text>", "the card's title, 1 to 32 characters")
    .addOption(new Option("--category <category>", "what is sold").choices(["physical_goods", "digital_goods", "donation"]).makeOptionMandatory())
    .option("--amount <number>", "the price in the currency's minor units", positiveInteger)
    .option("--currency <code>", "a 3-letter ISO 4217 code")
    .addOption(new Option("--mode <mode>", "payment or subscription").choices(["payment", "subscription"]))
    .option("--price-id <id>", "a recurring Stripe price, for subscriptions")
    .option("--quantity <number>", "units of the price", positiveInteger)
    .option("--customer-id <id>", "an existing Stripe customer")
    .option("--image-url <url>", "an https product picture")
    .option("--coupon <id>", "a Stripe coupon to apply")
    .option("--promotion-code <id>", "a Stripe promotion code ID")
    .option("--discount-label <text>", "your name for the discount")
    .option("--metadata <key=value>", "your own data, repeated", (value: string, previous: string[] = []) => [...previous, value])
    .option("--idempotency-key <key>", "duplicate-request prevention key")
    .action(async (
      options: {
        description: string; category: PaymentCategory; amount?: number; currency?: string; mode?: PaymentMode;
        priceId?: string; quantity?: number; customerId?: string; imageUrl?: string;
        coupon?: string; promotionCode?: string; discountLabel?: string; metadata?: string[]; idempotencyKey?: string;
      },
      command: Command,
    ) => {
      const metadata: Record<string, string> = {};
      for (const entry of options.metadata ?? []) {
        const at = entry.indexOf("=");
        if (at < 1) throw new Error("--metadata must be key=value.");
        metadata[entry.slice(0, at)] = entry.slice(at + 1);
      }
      const discount = {
        ...(options.coupon === undefined ? {} : { coupon: options.coupon }),
        ...(options.promotionCode === undefined ? {} : { promotion_code: options.promotionCode }),
        ...(options.discountLabel === undefined ? {} : { label: options.discountLabel }),
      };
      const body = {
        description: options.description,
        category: options.category,
        ...(options.amount === undefined ? {} : { amount: options.amount }),
        ...(options.currency === undefined ? {} : { currency: options.currency }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.priceId === undefined ? {} : { price_id: options.priceId }),
        ...(options.quantity === undefined ? {} : { quantity: options.quantity }),
        ...(options.customerId === undefined ? {} : { customer_id: options.customerId }),
        ...(options.imageUrl === undefined ? {} : { image_url: options.imageUrl }),
        ...(Object.keys(discount).length ? { discount } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {}),
      } satisfies PaymentRequestCreateParams;
      output(await (await clientFor(command)).paymentRequests.create(body, { idempotencyKey: idempotencyKeyOrNew(options.idempotencyKey) }));
    });
  payments
    .command("list")
    .description("list this agent's payment requests, newest first")
    .addOption(new Option("--status <status>", "only requests in this state").choices(["requested", "succeeded", "canceled", "expired"]))
    .option("--cursor <cursor>", "the cursor from the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .action(async (options: { status?: PaymentStatus; cursor?: string; limit?: number }, command: Command) =>
      output(await (await clientFor(command)).paymentRequests.list(options)));
  payments
    .command("get")
    .description("show one payment request")
    .argument("<payment-request-id>", "the payment request ID")
    .action(async (id: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).paymentRequests.retrieve(id)));
  payments
    .command("cancel")
    .description("cancel a payment request nobody has paid")
    .argument("<payment-request-id>", "the payment request ID")
    .action(async (id: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).paymentRequests.cancel(id)));

  const calls = program.command("calls", { hidden: true }).description("start, list and end calls").helpGroup(HELP_GROUPS.everythingElse);
  calls
    .command("create")
    .description("call the person in a chat")
    .argument("<chat-id>", "the chat ID")
    .requiredOption("--to <handle>", "the person to call", handle)
    .option("--idempotency-key <key>", "duplicate-call prevention key")
    .action(async (chatID: string, options: { to: string; idempotencyKey?: string }, command: Command) =>
      output(await (await clientFor(command)).calls.create(chatID, { to: [options.to] },
        { idempotencyKey: idempotencyKeyOrNew(options.idempotencyKey) })));
  calls
    .command("list")
    .description("list a chat's calls, one page at a time")
    .argument("<chat-id>", "the chat ID")
    .option("--cursor <cursor>", "the cursor from the previous page")
    .option("--limit <number>", "page size", positiveInteger)
    .action(async (chatID: string, options: { cursor?: string; limit?: number }, command: Command) =>
      output(await (await clientFor(command)).calls.list(chatID, options)));
  calls
    .command("get")
    .description("show one call")
    .argument("<call-id>", "the call ID")
    .action(async (callID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).calls.retrieve(callID)));
  calls
    .command("end")
    .description("end a call")
    .argument("<call-id>", "the call ID")
    .action(async (callID: string, _options: object, command: Command) =>
      output(await (await clientFor(command)).calls.end(callID)));

  const contacts = program.command("contacts", { hidden: true }).description("look up a person or agent").helpGroup(HELP_GROUPS.everythingElse);
  contacts
    .command("lookup")
    .description("find a person or agent by handle or need")
    .option("--handle <handle>", "the contact's handle", handle)
    .option("--id <id>", "the contact's ID, such as a card's")
    .option("--task <text>", "what you need done, in plain words")
    .action(async (options: { handle?: string; id?: string; task?: string }, command: Command) => {
      const given = [options.handle, options.id, options.task].filter((value) => value !== undefined);
      if (given.length !== 1) throw new Error("Choose exactly one of --handle, --id or --task.");
      const body: ContactLookupParams = options.handle !== undefined
        ? { handle: options.handle }
        : options.id !== undefined
        ? { id: nonempty("ID", options.id) }
        : { task: nonempty("Task", options.task!) };
      output(await (await clientFor(command)).contacts.lookup(body));
    });

  program
    .command("me", { hidden: true })
    .description("show the agent this token signs in as")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).me.retrieve()));

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
};
