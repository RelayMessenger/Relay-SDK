import {
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
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

/**
 * Bounds on the forward walk that serves a backward `fetchMessages`. The page
 * size is the contract's maximum (`contracts/relay-openapi.yaml`, `getMessages`
 * `limit` maximum 100), so the walk reaches the tail in the fewest requests
 * Relay allows.
 */
export const RELAY_BACKWARD_WALK_PAGE_SIZE = 100;
export const RELAY_BACKWARD_WALK_MAX_PAGES = 10;

/**
 * How many Chat kinds one adapter remembers for {@link RelayAdapter.isDM}.
 * A Chat is created direct or group and never changes, so an entry never goes
 * stale; the bound exists only so a long-lived agent cannot grow the memo
 * without limit.
 */
export const RELAY_CHAT_KIND_CACHE_LIMIT = 1_000;

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
   * Mark the Relay chat read as soon as an inbound message is verified,
   * before the event reaches Chat SDK dispatch.
   *
   * A read receipt is a statement about delivery, not about the answer, so a
   * debounce window, a queue or a model turn must never delay it. Turn this on
   * whenever the agent uses a `concurrency` strategy that defers the handler,
   * or whenever the read should land within a second of the send.
   *
   * Defaults to false, which leaves the read to the handler.
   */
  markReadOnReceipt?: boolean;
  /**
   * Cancel the chat's running turn when a newer inbound message arrives,
   * before the new event reaches Chat SDK dispatch.
   *
   * A person who sends again while the agent is answering has changed the
   * question. Finishing the old answer spends a model turn on a question that
   * no longer stands and posts a reply to nothing. This calls
   * `ChatInstance.abortTurn(threadId)`, so the running turn's `context.signal`
   * fires and the deferring `concurrency` strategy hands the newer message to
   * a fresh turn.
   *
   * Requires `supportsTurnCancellation`, which this adapter sets. Defaults to
   * false, which lets the running turn finish.
   */
  abortActiveTurnOnReceipt?: boolean;
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
  /**
   * Publish active turns so `ChatInstance.abortTurn(threadId)` cancels work
   * running in another process that shares the configured state adapter. A
   * Relay send is one idempotent HTTP request, so an aborted turn leaves no
   * partial bubble to reconcile.
   */
  readonly supportsTurnCancellation = true;
  readonly typing: boolean;
  readonly client: RelayClient;

  private readonly abortActiveTurnOnReceipt: boolean;
  private readonly markReadOnReceipt: boolean;
  private readonly signatureToleranceSeconds?: number;
  private readonly webhookSecret: RelayCredential | undefined;
  private readonly idempotencyKeyResolver:
    | RelayIdempotencyKeyResolver
    | undefined;
  private readonly turns = new RelayTurnContext();
  /**
   * Chat UUID to `is_group`, as Relay reported it.
   *
   * `isDM` must answer synchronously, and Relay's stable thread ID carries
   * only the Chat UUID by design, so the answer has to come from somewhere
   * the adapter already learned it. Every path that reads a Chat from Relay
   * records the flag here: inbound webhook dispatch, `fetchThread`, and
   * `onThreadSubscribe`.
   *
   * This is a memo of an immutable Relay fact — a Chat is created direct or
   * group and never changes — not a delivery record and not persistence. It
   * is bounded so a long-lived agent in many chats cannot grow it without
   * limit.
   */
  private readonly chatIsGroup = new Map<string, boolean>();
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
    this.abortActiveTurnOnReceipt =
      options.abortActiveTurnOnReceipt ?? false;
    this.markReadOnReceipt = options.markReadOnReceipt ?? false;
    this.signatureToleranceSeconds =
      options.signatureToleranceSeconds;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  /**
   * Report a non-fatal condition through Chat's logger once initialized, and
   * through the console before that, so a warning is never lost to whichever
   * side of `initialize` it happens on.
   */
  private warn(event: string, fields: Record<string, unknown>): void {
    const logger = this.chat?.getLogger("relay");
    if (logger) logger.warn(event, fields);
    else console.warn(JSON.stringify({ event, ...fields }));
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
   * Mint a replacement download URL for an attachment id.
   *
   * Returns `undefined` when the call cannot produce one and the caller still
   * holds a fallback URL; rethrows when there is nothing to fall back to, so a
   * genuine authorization or not-found failure is never swallowed.
   */
  private async freshDownloadUrl(
    attachmentId: string,
    hasFallback: boolean,
  ): Promise<string | undefined> {
    try {
      const attachment = await this.client.getAttachment(attachmentId);
      if (attachment.download_url) return attachment.download_url;
    } catch (error) {
      if (!hasFallback) throw error;
      return undefined;
    }
    if (!hasFallback) {
      throw new ValidationError(
        "relay",
        `Relay attachment ${attachmentId} has no download URL`,
      );
    }
    return undefined;
  }

  /**
   * Build the `fetchData` closure for an attachment that survived a queue.
   *
   * The stored URL may already have expired, so the id is tried first: Relay
   * mints a new download link on every `GET /v1/attachments/{attachmentId}`.
   * The serialized URL is the fallback for the one case the id cannot cover —
   * an attachment whose `fetchMetadata` predates this adapter version.
   */
  private rehydratedAttachmentData(
    attachmentId: string | undefined,
    url: string | undefined,
  ): () => Promise<ArrayBuffer> {
    return async () => {
      const fresh = attachmentId
        ? await this.freshDownloadUrl(attachmentId, url !== undefined)
        : undefined;
      const target = fresh ?? url;
      if (!target) {
        throw new ValidationError(
          "relay",
          "A rehydrated Relay attachment needs fetchMetadata.attachmentId "
            + "or a URL",
        );
      }
      return this.client.downloadAttachment({
        ...(attachmentId ? { attachmentId } : {}),
        url: target,
      });
    };
  }

  /**
   * Rebuild `fetchData` on an attachment that survived serialization.
   *
   * `Message.toJSON()` drops `data` and `fetchData`, so Chat SDK calls this
   * when a queue or debounce strategy rehydrates a Message. A Relay download
   * URL expires 60 minutes after Relay minted it, and a queue can hold a
   * Message for longer, so this re-mints from `fetchMetadata.attachmentId` and
   * falls back to the stored URL only when the id call cannot serve one.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    const attachmentId = attachment.fetchMetadata?.attachmentId;
    const url = attachment.fetchMetadata?.url ?? attachment.url;
    if (!attachmentId && !url) return attachment;
    return {
      ...attachment,
      fetchData: this.rehydratedAttachmentData(attachmentId, url),
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
    const parts = await buildRelayParts(message, (upload) =>
      this.client.uploadAttachment(upload),
    );
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

  /**
   * Record what Relay said about a Chat's kind. Re-recording a known chat
   * refreshes its position so the bound evicts the least recently learned.
   */
  private rememberChatKind(chatId: string, isGroup: boolean): void {
    this.chatIsGroup.delete(chatId);
    this.chatIsGroup.set(chatId, isGroup);
    while (this.chatIsGroup.size > RELAY_CHAT_KIND_CACHE_LIMIT) {
      const oldest = this.chatIsGroup.keys().next();
      if (oldest.done) break;
      this.chatIsGroup.delete(oldest.value);
    }
  }

  /**
   * Whether a thread is a direct conversation rather than a group.
   *
   * Chat SDK asks synchronously, and Relay's stable thread ID carries only
   * the Chat UUID, so this answers from what the adapter has already learned:
   * an inbound webhook dispatch, a `fetchThread`, or `onThreadSubscribe`.
   *
   * A chat this adapter has never seen answers `false` and says so on the
   * debug log. `false` is the safe direction — it is the group answer, so a
   * handler gates on mentions rather than replying to everything — and
   * `fetchThread(threadId)` settles the question for good.
   */
  isDM(threadId: string): boolean {
    const { chatId } = this.decodeThreadId(threadId);
    const isGroup = this.chatIsGroup.get(chatId);
    if (isGroup === undefined) {
      this.chat
        ?.getLogger(RELAY_ADAPTER_NAME)
        .debug(
          `isDM("${threadId}") answered false: this adapter has not seen `
            + "chat "
            + chatId
            + " yet. Call fetchThread(threadId) to settle it.",
        );
      return false;
    }
    return !isGroup;
  }

  /**
   * Learn a thread's kind when Chat SDK subscribes to it, so `isDM` answers
   * correctly from the first handler call rather than after the first fetch.
   */
  async onThreadSubscribe(threadId: string): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    if (this.chatIsGroup.has(chatId)) return;
    const chat = await this.client.getChat(chatId);
    this.rememberChatKind(chatId, chat.is_group);
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
   * Fetch messages from a Relay chat.
   *
   * `forward` is Relay's native shape: one `GET /v1/chats/{id}/messages` per
   * call, and `nextCursor` is Relay's own cursor pointing at newer messages.
   *
   * `backward` — the Chat SDK default, and what `thread.fetchMessages()` asks
   * for when loading a chat view — has no native Relay equivalent, because
   * the public contract publishes exactly one opaque cursor and it advances
   * oldest-to-newest. It is served by walking forward to the tail and keeping
   * the newest `limit` messages seen.
   *
   * **The cost is real and worth knowing before you call it.** One backward
   * call issues up to {@link RELAY_BACKWARD_WALK_MAX_PAGES} requests of
   * {@link RELAY_BACKWARD_WALK_PAGE_SIZE} messages each — up to 10 round
   * trips covering 1000 messages — rather than the single request `forward`
   * costs. Chats shorter than one page cost exactly one request, which is the
   * common case.
   *
   * If the walk reaches the end of the chat, the result is exactly the most
   * recent `limit` messages and there is no `nextCursor`: Relay cannot
   * address older messages, so there is no further backward page to offer.
   *
   * If the walk is cut short by the page cap, the messages are the newest the
   * bounded walk could reach and `nextCursor` carries Relay's live forward
   * cursor. Passing it back as `cursor` resumes the walk from that point
   * rather than moving to older messages, so repeated calls converge on the
   * true tail. That is the opposite of the generic backward contract, and it
   * is the only meaning Relay's single forward cursor can carry.
   *
   * Messages are returned oldest-first within the page in every direction, as
   * the interface requires.
   */
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<RelayRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const limit = Math.min(
      100,
      Math.max(1, Math.trunc(options?.limit ?? 50)),
    );
    if (options?.direction === "forward") {
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

    let cursor = options?.cursor;
    let newest: RelayMessage[] = [];
    let truncated = false;
    for (
      let page = 0;
      page < RELAY_BACKWARD_WALK_MAX_PAGES;
      page += 1
    ) {
      const result = await this.client.getMessages({
        chatId,
        limit: RELAY_BACKWARD_WALK_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      // Keep only the newest `limit` seen so a deep chat costs bounded memory.
      newest = newest.concat(result.messages).slice(-limit);
      cursor = result.next_cursor ?? undefined;
      if (!cursor) break;
      truncated = page === RELAY_BACKWARD_WALK_MAX_PAGES - 1;
    }
    return {
      messages: newest.map((message) =>
        this.parseMessage({ chatId, message }),
      ),
      ...(truncated && cursor ? { nextCursor: cursor } : {}),
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
      // The client maps a Relay 404 onto the shared class, so the absent
      // message is recognised by meaning rather than by HTTP status.
      if (error instanceof ResourceNotFoundError) return null;
      throw error;
    }
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this.client.getChat(chatId);
    this.rememberChatKind(chatId, chat.is_group);
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

  /**
   * Stamp the Relay read receipt for one inbound chat.
   *
   * A failed read never blocks the webhook's 2xx. Holding the response open
   * for it would make Relay time the delivery out and redeliver, which costs
   * the agent a retry to buy a receipt that Relay will re-request anyway.
   */
  private async readOnReceipt(chatId: string): Promise<void> {
    try {
      await this.client.markChatRead(chatId);
    } catch (error) {
      this.warn("relay_read_on_receipt_failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cancel the chat's running turn, if there is one.
   *
   * `abortTurn` is a no-op when nothing is active, so a burst's first message
   * costs one state read. A failure is logged and never blocks the delivery:
   * the worst case is that the superseded turn finishes and posts, which is
   * the behaviour of an agent without this option.
   */
  private async abortOnReceipt(threadId: string): Promise<void> {
    try {
      await this.initializedChat().abortTurn(threadId);
    } catch (error) {
      this.warn("relay_abort_on_receipt_failed", {
        error: error instanceof Error ? error.message : String(error),
        threadId,
      });
    }
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
        // The event already carries the Chat's kind, so an inbound dispatch
        // settles isDM for this chat without spending a request on it.
        this.rememberChatKind(
          data.chat.id,
          data.chat.is_group === true,
        );
        // A newer message supersedes the question the running turn is
        // answering, so it is cancelled before the new event is queued.
        // This runs first: the read is an HTTP round trip to Relay, and the
        // sooner the old turn stops, the less model time is spent on a
        // question that no longer stands.
        if (this.abortActiveTurnOnReceipt) {
          await this.abortOnReceipt(threadId);
        }
        // Read is a receipt about delivery, so it is stamped here — after the
        // signature proved the event, and before Chat SDK dispatch, which a
        // debounce, queue or burst window may defer for seconds.
        if (this.markReadOnReceipt) {
          await this.readOnReceipt(data.chat.id);
        }
        await this.initializedChat().processMessage(
          this,
          threadId,
          this.parseMessage(raw),
          options,
        );
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
