import { ValidationError } from "@chat-adapter/shared";
import {
  Message,
  NotImplementedError,
  paragraph,
  root,
  text,
  toPlainText,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type LinkPreview,
  type RawMessage,
  type StreamChunk,
  type ThreadInfo,
  type UserInfo,
  type WebhookOptions,
} from "chat";
import { RelayApiError, RelayClient } from "./client.js";
import type { RelayClientOptions } from "./client.js";
import {
  relayEnv,
  type RelayCredential,
  validateStaticCredential,
} from "./credentials.js";
import {
  buildRelayParts,
  hasPostableContent,
} from "./content.js";
import {
  fromRelayReaction,
  toRelayReaction,
} from "./reactions.js";
import {
  decodeWebhookSecret,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "./signature.js";
import {
  assertRelayUuid,
  decodeRelayThreadId,
  encodeRelayThreadId,
  relayChannelIdFromThreadId,
} from "./thread-id.js";
import type {
  RelayChatHandle,
  RelayMessage,
  RelayMessagePartResponse,
  RelayRawMessage,
  RelaySentMessage,
  RelayThreadId,
  RelayWebhookEnvelope,
  RelayWebhookMessageEvent,
} from "./types.js";
import {
  inboundIdempotencyKey,
  RelayTurnContext,
  type RelayTurn,
} from "./turn.js";
import {
  assertExhaustiveEvent,
  parseReactionEvent,
  parseWebhookEnvelope,
  parseWebhookMessageEvent,
  readWebhookBody,
} from "./webhook.js";

export const RELAY_ADAPTER_NAME = "relay";

export interface RelayIdempotencyKeyContext {
  chatId: string;
  parts: ReadonlyArray<import("./types.js").RelayOutgoingPart>;
  replyToMessageId?: string;
  threadId: string;
}

export type RelayIdempotencyKeyResolver = (
  context: RelayIdempotencyKeyContext,
) => string | Promise<string>;

export interface RelayAdapterOptions
  extends Omit<RelayClientOptions, "token"> {
  /**
   * Relay Agent Token or per-call resolver.
   * Defaults to `RELAY_AGENT_TOKEN`.
   */
  token?: RelayCredential;
  /**
   * Standard Webhooks signing secret or per-delivery resolver.
   * Defaults to `RELAY_WEBHOOK_SECRET`.
   */
  webhookSecret?: RelayCredential;
  /**
   * Disable Chat SDK surface typing for runtimes that own typing UX.
   * Defaults to true.
   */
  typing?: boolean;
  /** Display name shown to Chat SDK handlers. */
  userName?: string;
  /** This Relay agent Contact UUID, when known. */
  agentId?: string;
  /** Standard Webhooks timestamp tolerance in seconds. */
  signatureToleranceSeconds?: number;
  /**
   * Stable key source for posts made outside an inbound webhook turn.
   * Inbound turns always derive keys from event_id plus send ordinal.
   */
  idempotencyKeyResolver?: RelayIdempotencyKeyResolver;
  /** Controlled client injection for tests and custom transports. */
  client?: RelayClient;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function isWebhookMessage(
  message: RelayRawMessage["message"],
): message is RelayWebhookMessageEvent {
  return message !== null && "chat" in message;
}

function isRestMessage(
  message: RelayRawMessage["message"],
): message is RelayMessage {
  return message !== null && "chat_id" in message;
}

function messageParts(
  message: RelayRawMessage["message"],
): RelayMessagePartResponse[] {
  if (message === null) return [];
  return (message.parts ?? []) as RelayMessagePartResponse[];
}

function textAndLinks(parts: RelayMessagePartResponse[]): {
  links: LinkPreview[];
  value: string;
} {
  const pieces: string[] = [];
  const links: LinkPreview[] = [];
  for (const part of parts) {
    if (
      part.type === "text" ||
      part.type === "system"
    ) {
      if (part.value) pieces.push(part.value);
    } else if (part.type === "link") {
      pieces.push(part.value);
      links.push({ url: part.value });
    }
  }
  return { links, value: pieces.join("\n\n") };
}

function attachmentType(
  mimeType: string,
): Attachment["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function messageHandle(
  message: RelayRawMessage["message"],
): RelayChatHandle | null | undefined {
  if (message === null) return undefined;
  if (isWebhookMessage(message)) return message.sender_handle;
  return message.from_handle;
}

function messageDate(
  raw: RelayRawMessage,
): Date {
  const message = raw.message;
  if (message === null) return new Date(0);
  const candidate = isWebhookMessage(message)
    ? message.sent_at ?? raw.createdAt
    : message.created_at;
  const date = new Date(candidate ?? 0);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function messageIsMe(
  message: RelayRawMessage["message"],
): boolean {
  if (message === null) return true;
  if (isWebhookMessage(message)) {
    return message.direction === "outbound";
  }
  if (isRestMessage(message)) return message.is_from_me;
  return true;
}

/**
 * Relay adapter for `chat@4.39.0`, limited to the locked public v1 contract.
 */
export class RelayAdapter
  implements Adapter<RelayThreadId, RelayRawMessage>
{
  readonly name = RELAY_ADAPTER_NAME;
  readonly userName: string;
  readonly botUserId?: string;
  readonly lockScope = "thread" as const;
  readonly persistThreadHistory = false;
  readonly typing: boolean;
  readonly client: RelayClient;

  private readonly signatureToleranceSeconds?: number;
  private readonly webhookSecret: RelayCredential | undefined;
  private readonly idempotencyKeyResolver:
    | RelayIdempotencyKeyResolver
    | undefined;
  private readonly turns = new RelayTurnContext();
  /**
   * Request-scoped Chat kind hints. Entries exist only while an inbound
   * dispatch is active; this is not persistence or a delivery-idempotency
   * store.
   */
  private readonly activeChatKinds = new Map<
    string,
    { direct: number; group: number }
  >();
  private chat?: ChatInstance;

  constructor(options: RelayAdapterOptions = {}) {
    const token = options.token ?? relayEnv("RELAY_AGENT_TOKEN");
    const webhookSecret =
      options.webhookSecret ?? relayEnv("RELAY_WEBHOOK_SECRET");
    validateStaticCredential(token, "Relay Agent Token");
    validateStaticCredential(
      webhookSecret,
      "Relay webhook signing secret",
    );
    if (typeof webhookSecret === "string") {
      decodeWebhookSecret(webhookSecret);
    }
    if (options.agentId) {
      assertRelayUuid(options.agentId, "agentId");
      this.botUserId = options.agentId;
    }
    this.client =
      options.client ??
      new RelayClient({
        token,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.webhookSecret = webhookSecret;
    this.userName = options.userName ?? "Relay Agent";
    this.typing = options.typing ?? true;
    this.idempotencyKeyResolver = options.idempotencyKeyResolver;
    this.signatureToleranceSeconds =
      options.signatureToleranceSeconds;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  encodeThreadId(data: RelayThreadId): string {
    return encodeRelayThreadId(data);
  }

  decodeThreadId(threadId: string): RelayThreadId {
    return decodeRelayThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return relayChannelIdFromThreadId(threadId);
  }

  renderFormatted(content: FormattedContent): string {
    return toPlainText(content);
  }

  /**
   * Build the Chat SDK `fetchData` closure for one Relay media part.
   *
   * The download runs through this adapter's own Relay client, so a consumer
   * supplied `fetch` (Workers, a proxy, a test double) serves attachment bytes
   * exactly as it serves every other Relay call.
   */
  private attachmentData(
    url: string,
    attachmentId?: string,
  ): () => Promise<ArrayBuffer> {
    return () =>
      this.client.downloadAttachment({
        ...(attachmentId ? { attachmentId } : {}),
        url,
      });
  }

  /**
   * Rebuild `fetchData` on an attachment that survived serialization.
   *
   * `Message.toJSON()` drops `data` and `fetchData`, so Chat SDK calls this
   * when a queue or debounce strategy rehydrates a Message. The Relay media
   * URL kept in `fetchMetadata.url` is the whole capability; it expires 15
   * minutes after Relay minted it, and a rehydrated download after that window
   * fails with HTTP 404 because Relay has no agent-facing route that re-mints
   * a URL from `fetchMetadata.attachmentId`.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    const url = attachment.fetchMetadata?.url ?? attachment.url;
    if (!url) return attachment;
    return {
      ...attachment,
      fetchData: this.attachmentData(
        url,
        attachment.fetchMetadata?.attachmentId,
      ),
    };
  }

  parseMessage(raw: RelayRawMessage): Message<RelayRawMessage> {
    const threadId = this.encodeThreadId({ chatId: raw.chatId });
    const message = raw.message;
    if (message === null) {
      throw new ValidationError(
        "relay",
        "A no-op Relay result is not an inbound message",
      );
    }
    const parts = messageParts(message);
    const content = textAndLinks(parts);
    const handle = messageHandle(message);
    const system =
      isRestMessage(message) && message.is_system_message;
    const userId =
      handle?.id ??
      (system ? "relay-system" : this.botUserId ?? "relay-agent");
    const userName =
      handle?.handle ??
      (system ? "relay-system" : this.userName);
    const fullName =
      handle?.display_name ?? userName;

    const attachments: Attachment[] = parts
      .filter(
        (part): part is Extract<
          RelayMessagePartResponse,
          { type: "media" }
        > => part.type === "media",
      )
      .map((part) => ({
        fetchData: this.attachmentData(part.url, part.id),
        fetchMetadata: { attachmentId: part.id, url: part.url },
        ...(part.height != null ? { height: part.height } : {}),
        mimeType: part.mime_type,
        name: part.filename,
        size: part.size_bytes,
        type: attachmentType(part.mime_type),
        url: part.url,
        ...(part.width != null ? { width: part.width } : {}),
      }));

    return new Message<RelayRawMessage>({
      attachments,
      author: {
        fullName,
        isBot: system ? false : handle?.kind === "agent",
        isMe: messageIsMe(message),
        ...(system ? { isSystem: true } : {}),
        userId,
        userName,
      },
      formatted: content.value
        ? root([paragraph([text(content.value)])])
        : root([]),
      id: message.id,
      ...(raw.eventType === "message.received" &&
      isWebhookMessage(message)
        ? { isMention: this.isMentioned(message) }
        : {}),
      ...(content.links.length ? { links: content.links } : {}),
      metadata: {
        dateSent: messageDate(raw),
        edited: false,
      },
      raw,
      text: content.value,
      threadId,
    });
  }

  private unsupported(feature: string, detail: string): never {
    throw new NotImplementedError(
      `${detail} The locked Relay v1 contract does not expose ${feature}.`,
      feature,
    );
  }

  private async send(
    threadId: string,
    message: AdapterPostableMessage,
    replyToMessageId?: string,
  ): Promise<RawMessage<RelayRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const turn = this.turns.active();
    if (
      !turn &&
      !this.idempotencyKeyResolver &&
      hasPostableContent(message)
    ) {
      throw new ValidationError(
        "relay",
        "Relay posts outside an inbound webhook require idempotencyKeyResolver",
      );
    }
    const parts = await buildRelayParts(message);
    if (parts.length === 0) {
      return this.noopResult(chatId, threadId);
    }
    const send = async (idempotencyKey: string) =>
      this.client.sendMessage({
        chatId,
        idempotencyKey,
        parts,
        ...(replyToMessageId
          ? { replyTo: { messageId: replyToMessageId } }
          : {}),
      });
    const result = turn
      ? await this.sendInTurn(turn, send)
      : await send(
          await this.resolveExternalIdempotencyKey({
            chatId,
            parts,
            ...(replyToMessageId
              ? { replyToMessageId }
              : {}),
            threadId,
          }),
        );
    if (result.chat_id !== chatId) {
      throw new RelayApiError(
        502,
        "chat_mismatch",
        "Relay send response returned a different chat_id",
        result,
      );
    }
    return {
      id: result.message.id,
      raw: {
        chatId,
        message: result.message,
      },
      threadId,
    };
  }

  private async sendInTurn<T>(
    turn: RelayTurn,
    send: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    const previous = turn.tail;
    let release: () => void = () => undefined;
    turn.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const ordinal = turn.sent;
    turn.sent += 1;
    try {
      const result = await send(
        inboundIdempotencyKey(turn.eventId, ordinal),
      );
      return result;
    } finally {
      release();
    }
  }

  private async resolveExternalIdempotencyKey(
    context: RelayIdempotencyKeyContext,
  ): Promise<string> {
    if (!this.idempotencyKeyResolver) {
      throw new ValidationError(
        "relay",
        "Relay posts outside an inbound webhook require idempotencyKeyResolver",
      );
    }
    const key = await this.idempotencyKeyResolver(context);
    if (!key || key.length > 255) {
      throw new ValidationError(
        "relay",
        "idempotencyKeyResolver must return 1–255 characters",
      );
    }
    return key;
  }

  private noopResult(
    chatId: string,
    threadId: string,
  ): RawMessage<RelayRawMessage> {
    return {
      // Chat SDK requires a RawMessage to suppress its post+edit fallback.
      // This UUID is local to the returned no-op SentMessage and is never sent
      // to Relay or retained by the adapter.
      id: crypto.randomUUID(),
      raw: { chatId, message: null, noop: true },
      threadId,
    };
  }

  private isMentioned(message: RelayWebhookMessageEvent): boolean {
    if (message.chat.is_group !== true) return false;
    const owner = message.chat.owner_handle;
    if (!owner) return false;
    if (this.botUserId && owner.id !== this.botUserId) return false;
    return message.parts.some(
      (part) =>
        part.type === "text" &&
        part.mention === owner.handle,
    );
  }

  private enterChatKind(chatId: string, isGroup: boolean): () => void {
    const counts = this.activeChatKinds.get(chatId) ?? {
      direct: 0,
      group: 0,
    };
    if (isGroup) counts.group += 1;
    else counts.direct += 1;
    this.activeChatKinds.set(chatId, counts);
    return () => {
      const current = this.activeChatKinds.get(chatId);
      if (!current) return;
      if (isGroup) current.group -= 1;
      else current.direct -= 1;
      if (current.direct === 0 && current.group === 0) {
        this.activeChatKinds.delete(chatId);
      }
    };
  }

  /**
   * Chat SDK asks synchronously while dispatching. Relay's stable thread ID
   * intentionally contains only the Chat UUID, so the direct/group hint is
   * scoped to the active webhook dispatch and never persisted.
   */
  isDM(threadId: string): boolean {
    const { chatId } = this.decodeThreadId(threadId);
    const counts = this.activeChatKinds.get(chatId);
    return Boolean(counts && counts.direct > 0 && counts.group === 0);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RelayRawMessage>> {
    return this.send(threadId, message);
  }

  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RelayRawMessage>> {
    return this.send(
      this.channelIdFromThreadId(channelId),
      message,
    );
  }

  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RelayRawMessage>> {
    assertRelayUuid(messageId, "messageId");
    return this.send(threadId, message, messageId);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<RelayRawMessage>> {
    this.decodeThreadId(threadId);
    assertRelayUuid(messageId, "messageId");
    return this.unsupported(
      "editMessage",
      "Relay messages cannot be edited through the public API.",
    );
  }

  async deleteMessage(
    threadId: string,
    messageId: string,
  ): Promise<void> {
    this.decodeThreadId(threadId);
    assertRelayUuid(messageId, "messageId");
    this.unsupported(
      "deleteMessage",
      "Relay messages cannot be deleted through the public API.",
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    this.decodeThreadId(threadId);
    const reaction = toRelayReaction(emoji);
    await this.client.react({
      ...(reaction.customEmoji
        ? { customEmoji: reaction.customEmoji }
        : {}),
      messageId,
      operation: "add",
      type: reaction.type,
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    this.decodeThreadId(threadId);
    const reaction = toRelayReaction(emoji);
    await this.client.react({
      ...(reaction.customEmoji
        ? { customEmoji: reaction.customEmoji }
        : {}),
      messageId,
      operation: "remove",
      type: reaction.type,
    });
  }

  async startTyping(threadId: string): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    if (!this.typing) return;
    await this.client.setTyping(chatId, true);
  }

  async endTyping(threadId: string): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    if (!this.typing) return;
    await this.client.setTyping(chatId, false);
  }

  async markAsRead(
    threadId: string,
    messageId: string,
  ): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    assertRelayUuid(messageId, "messageId");
    await this.client.markChatRead(chatId);
  }

  /**
   * Relay's public chat cursor advances oldest-to-newest. Chat SDK's backward
   * cursor contract cannot be represented, so only explicit forward reads are
   * supported rather than faking backward pagination.
   */
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<RelayRawMessage>> {
    if (options?.direction !== "forward") {
      return this.unsupported(
        "fetchMessages(backward)",
        "Relay chat history exposes only an opaque forward cursor.",
      );
    }
    const { chatId } = this.decodeThreadId(threadId);
    const limit = Math.min(
      100,
      Math.max(1, Math.trunc(options.limit ?? 50)),
    );
    const result = await this.client.getMessages({
      chatId,
      limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    return {
      messages: result.messages.map((message) =>
        this.parseMessage({ chatId, message }),
      ),
      ...(result.next_cursor
        ? { nextCursor: result.next_cursor }
        : {}),
    };
  }

  async fetchChannelMessages(
    channelId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<RelayRawMessage>> {
    return this.fetchMessages(
      this.channelIdFromThreadId(channelId),
      options,
    );
  }

  async fetchMessage(
    threadId: string,
    messageId: string,
  ): Promise<Message<RelayRawMessage> | null> {
    const { chatId } = this.decodeThreadId(threadId);
    try {
      const message = await this.client.getMessage(messageId);
      if (message.chat_id !== chatId) {
        throw new ValidationError(
          "relay",
          "The requested Relay message belongs to a different chat",
        );
      }
      return this.parseMessage({ chatId, message });
    } catch (error) {
      if (
        error instanceof RelayApiError &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this.client.getChat(chatId);
    return {
      channelId: threadId,
      ...(chat.display_name
        ? { channelName: chat.display_name }
        : {}),
      channelVisibility: "private",
      id: threadId,
      isDM: !chat.is_group,
      metadata: {
        groupChatIcon: chat.group_chat_icon ?? null,
        handles: chat.handles,
        isGroup: chat.is_group,
      },
    };
  }

  async fetchChannelInfo(channelId: string) {
    const thread = await this.fetchThread(
      this.channelIdFromThreadId(channelId),
    );
    return {
      channelVisibility: thread.channelVisibility,
      id: thread.channelId,
      isDM: thread.isDM,
      metadata: thread.metadata,
      ...(thread.channelName ? { name: thread.channelName } : {}),
    };
  }

  getChannelVisibility(): "private" {
    return "private";
  }

  async getUser(_userId: string): Promise<UserInfo | null> {
    return this.unsupported(
      "getUser",
      "Relay v1 has no public Contact lookup endpoint.",
    );
  }

  async openDM(_userId: string): Promise<string> {
    return this.unsupported(
      "openDM",
      "Relay chat creation requires an initial message and cannot implement an open-only DM operation.",
    );
  }

  async stream(
    threadId: string,
    stream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<RelayRawMessage> | null> {
    const chunks: string[] = [];
    for await (const chunk of stream) {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (chunk.type === "markdown_text") chunks.push(chunk.text);
      // Task/plan updates are transient progress, not canonical message text.
    }
    const markdown = chunks.join("");
    if (!markdown) {
      const { chatId } = this.decodeThreadId(threadId);
      return this.noopResult(chatId, threadId);
    }
    // Relay has no partial bubble or editable draft. Buffer first, then commit
    // exactly one canonical Message through the normal send path.
    return this.postMessage(threadId, { markdown });
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, {
        error: { code: "method_not_allowed" },
      });
    }
    if (!this.webhookSecret) {
      throw new ValidationError(
        "relay",
        "webhookSecret is required to receive Relay webhooks",
      );
    }

    let payload: string;
    try {
      payload = await readWebhookBody(request);
    } catch (error) {
      if (error instanceof RangeError) {
        return json(413, {
          error: { code: "payload_too_large" },
        });
      }
      return json(400, {
        error: { code: "invalid_utf8" },
      });
    }

    try {
      await verifyWebhookSignature({
        headers: request.headers,
        payload,
        secret: this.webhookSecret,
        options: {
          ...(this.signatureToleranceSeconds !== undefined
            ? {
                toleranceSeconds:
                  this.signatureToleranceSeconds,
              }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return json(401, {
          error: { code: "invalid_signature" },
        });
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(payload) as unknown;
    } catch {
      return json(400, {
        error: { code: "invalid_json" },
      });
    }

    let envelope: RelayWebhookEnvelope;
    try {
      envelope = parseWebhookEnvelope(decoded);
      await this.turns.run(envelope.event_id, () =>
        this.dispatch(envelope, options),
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        return json(422, {
          error: { code: "invalid_event" },
        });
      }
      throw error;
    }
    return json(200, {
      acknowledged: true,
      event_id: envelope.event_id,
      event_type: envelope.event_type,
    });
  }

  private initializedChat(): ChatInstance {
    if (!this.chat) {
      throw new Error(
        "RelayAdapter must be initialized by Chat before dispatch",
      );
    }
    return this.chat;
  }

  private async dispatch(
    envelope: RelayWebhookEnvelope,
    options?: WebhookOptions,
  ): Promise<void> {
    switch (envelope.event_type) {
      case "message.received": {
        const data = parseWebhookMessageEvent(envelope.data);
        if (
          data.direction === "outbound" ||
          data.sender_handle.is_me === true
        ) {
          return;
        }
        const raw: RelayRawMessage = {
          chatId: data.chat.id,
          createdAt: envelope.created_at,
          eventId: envelope.event_id,
          eventType: envelope.event_type,
          message: data,
        };
        const threadId = this.encodeThreadId({
          chatId: data.chat.id,
        });
        const leaveChatKind = this.enterChatKind(
          data.chat.id,
          data.chat.is_group === true,
        );
        try {
          await this.initializedChat().processMessage(
            this,
            threadId,
            this.parseMessage(raw),
            options,
          );
        } finally {
          leaveChatKind();
        }
        return;
      }
      case "message.sent":
      case "message.read":
      case "message.delivered":
        parseWebhookMessageEvent(envelope.data);
        return;
      case "reaction.added":
      case "reaction.removed": {
        const data = parseReactionEvent(envelope.data);
        if (data.is_from_me) return;
        const normalized = fromRelayReaction({
          ...(data.custom_emoji
            ? { customEmoji: data.custom_emoji }
            : {}),
          type: data.reaction_type,
        });
        const threadId = this.encodeThreadId({
          chatId: data.chat_id,
        });
        this.initializedChat().processReaction(
          {
            adapter: this,
            added: envelope.event_type === "reaction.added",
            emoji: normalized.emoji,
            messageId: data.message_id,
            raw: envelope,
            rawEmoji: normalized.rawEmoji,
            threadId,
            user: {
              fullName:
                data.from_handle.display_name ??
                data.from_handle.handle,
              isBot: data.from_handle.kind === "agent",
              isMe: false,
              userId: data.from_handle.id,
              userName: data.from_handle.handle,
            },
          },
          options,
        );
        return;
      }
      case "participant.added":
      case "participant.removed":
      case "chat.created":
      case "chat.group_name_updated":
      case "chat.group_icon_updated":
      case "chat.typing_indicator.started":
      case "chat.typing_indicator.stopped":
      case "contact.added":
      case "contact.removed":
        return;
      default:
        return assertExhaustiveEvent(envelope.event_type);
    }
  }
}

export function createRelayAdapter(
  options: RelayAdapterOptions = {},
): RelayAdapter {
  return new RelayAdapter(options);
}
