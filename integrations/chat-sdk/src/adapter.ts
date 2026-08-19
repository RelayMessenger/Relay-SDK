import {
  Message,
  NotImplementedError,
  cardChildToFallbackText,
  emphasis,
  inlineCode,
  isCardElement,
  paragraph,
  root,
  strikethrough,
  strong,
  text as textNode,
} from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  CardElement,
  ChatInstance,
  Content,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  LinkPreview,
  RawMessage,
  StreamChunk,
  ThreadInfo,
  UserInfo,
  WebhookOptions,
} from "chat";
import {
  MAX_PARTS_PER_MESSAGE,
  MAX_TEXT_PART_BYTES,
  chunkRenderedText,
} from "./chunk.js";
import { RelayClient } from "./client.js";
import type { RelayClientOptions } from "./client.js";
import {
  renderAst,
  renderMarkdown,
  renderRawText,
  type RenderedText,
} from "./format.js";
import {
  DedupeWindow,
  deriveIdempotencyKey,
  unkeyedIdempotencyKey,
} from "./idempotency.js";
import { toRelayReaction } from "./reactions.js";
import { verifyWebhookSignature, WebhookVerificationError } from "./signature.js";
import {
  decodeRelayThreadId,
  encodeRelayThreadId,
  relayChannelIdFromThreadId,
} from "./threadId.js";
import type {
  RelayEventEnvelope,
  RelayMessage,
  RelayMessageEventData,
  RelayMessageUnsentEventData,
  RelayOutgoingPart,
  RelayPart,
  RelayRawMessage,
  RelayThreadId,
} from "./types.js";

export const RELAY_ADAPTER_NAME = "relay";

export interface RelayAdapterOptions
  extends Omit<RelayClientOptions, "token"> {
  /** Agent Token. Defaults to `RELAY_AGENT_TOKEN`. */
  token?: string;
  /** Webhook signing secret. Defaults to `RELAY_WEBHOOK_SECRET`. */
  webhookSecret?: string;
  /** Display name for the agent. Defaults to `Relay Agent`. */
  userName?: string;
  /** This agent's `agt_` id, when the caller knows it. */
  agentId?: string;
  /** Clock tolerance for signature verification, in seconds. */
  toleranceSeconds?: number;
  /** How many handled `event_id` values to remember. */
  dedupeWindow?: number;
  /** Override the client, mainly for tests. */
  client?: RelayClient;
}

const DEFAULT_DEDUPE_WINDOW = 4096;
const DEFAULT_HISTORY_LIMIT = 50;

/**
 * What the inbound event told us about the turn now in flight on one
 * conversation. `postMessage` never sees the event, so the invocation id a
 * group reply must echo, and the event id an idempotency key must be derived
 * from, are carried here.
 *
 * One entry per conversation is enough because the adapter declares
 * `lockScope: "thread"`, so the Chat SDK serializes handlers for a thread and
 * two turns never write the same entry at once.
 */
interface TurnContext {
  eventId: string;
  invocationId?: string;
  invocationUsed: boolean;
  ordinal: number;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function toBytes(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

function mediaKindToAttachmentType(part: RelayPart): Attachment["type"] {
  if (part.type === "voice_memo") return "audio";
  switch (part.media_kind) {
    case "image":
    case "video":
    case "audio":
      return part.media_kind;
    default:
      return "file";
  }
}

/**
 * Rebuild an inline mdast run sequence from Relay's text plus style ranges, so
 * `message.formatted` carries the emphasis the sender actually applied instead
 * of a flat string. `underline` and `spoiler` have no mdast node, so those runs
 * keep their words and lose only the decoration.
 */
function formattedFromParts(value: string, styles: RelayPart["styles"]): FormattedContent {
  if (!value) return root([]);
  const ranges = (styles ?? []).filter((run) => run.length > 0);
  if (ranges.length === 0) return root([paragraph([textNode(value)])]);

  const children: Content[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      children.push(textNode(value.slice(cursor, range.start)));
    }
    const slice = value.slice(range.start, range.start + range.length);
    let node: Content = range.styles.includes("monospace")
      ? inlineCode(slice)
      : textNode(slice);
    if (range.styles.includes("strikethrough")) node = strikethrough([node]);
    if (range.styles.includes("italic")) node = emphasis([node]);
    if (range.styles.includes("bold")) node = strong([node]);
    children.push(node);
    cursor = range.start + range.length;
  }
  if (cursor < value.length) children.push(textNode(value.slice(cursor)));
  return root([paragraph(children)]);
}

/**
 * Relay adapter for the Vercel Chat SDK.
 *
 * Relay is a consumer messenger where people talk to agents as contacts, so
 * this adapter maps the Chat SDK's thread model onto Relay conversations one
 * to one: a Relay conversation has no enclosing channel, and a thread id is
 * `relay:{conversation_id}`.
 *
 * Two Relay rules shape the surface. A streamed turn commits exactly one
 * canonical message, so `stream` buffers and posts once rather than editing a
 * draft bubble into place. And a group reply is scoped to the single-use
 * invocation that produced the inbound event, so the first send of a turn
 * carries it and a second cannot.
 */
export class RelayAdapter implements Adapter<RelayThreadId, RelayRawMessage> {
  readonly name = RELAY_ADAPTER_NAME;
  readonly userName: string;
  readonly botUserId?: string;
  readonly lockScope = "thread" as const;
  /** Relay serves history from `GET /v1/conversations/{id}/messages`. */
  readonly persistThreadHistory = false;

  private readonly client: RelayClient;
  private readonly webhookSecret?: string;
  private readonly toleranceSeconds?: number;
  private readonly dedupe: DedupeWindow;
  private readonly turns = new Map<string, TurnContext>();
  private chat?: ChatInstance;

  constructor(options: RelayAdapterOptions = {}) {
    const token = options.token ?? process.env.RELAY_AGENT_TOKEN;
    this.client =
      options.client ??
      new RelayClient({
        token: token ?? "",
        baseUrl: options.baseUrl,
        fetch: options.fetch,
      });
    this.webhookSecret =
      options.webhookSecret ?? process.env.RELAY_WEBHOOK_SECRET;
    this.userName = options.userName ?? "Relay Agent";
    this.botUserId = options.agentId;
    this.toleranceSeconds = options.toleranceSeconds;
    this.dedupe = new DedupeWindow(options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW);
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  encodeThreadId(platformData: RelayThreadId): string {
    return encodeRelayThreadId(platformData);
  }

  decodeThreadId(threadId: string): RelayThreadId {
    return decodeRelayThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return relayChannelIdFromThreadId(threadId);
  }

  renderFormatted(content: FormattedContent): string {
    return renderAst(content).text;
  }

  parseMessage(raw: RelayRawMessage): Message<RelayRawMessage> {
    const message = raw.message;
    const threadId = this.encodeThreadId({ conversationId: message.conversation_id });
    const parts = message.parts ?? [];
    const textParts = parts.filter((part) => part.type === "text");
    const value =
      textParts.map((part) => part.text ?? "").join("\n\n") ||
      message.fallback_text ||
      "";
    const styles = textParts.length === 1 ? textParts[0]?.styles : undefined;

    const attachments: Attachment[] = parts
      .filter((part) => part.type === "media" || part.type === "voice_memo")
      .map((part) => ({
        type: mediaKindToAttachmentType(part),
        url: part.url,
        name: part.filename,
        mimeType: part.content_type,
        size: part.size_bytes,
        width: part.width,
        height: part.height,
        ...(part.attachment_id
          ? { fetchMetadata: { attachmentId: part.attachment_id } }
          : {}),
      }));

    const links: LinkPreview[] = parts
      .filter((part) => part.type === "link_preview" && part.url)
      .map((part) => ({
        url: part.url as string,
        title: part.title,
        description: part.description,
      }));

    return new Message<RelayRawMessage>({
      id: message.id,
      threadId,
      text: value,
      formatted: formattedFromParts(value, styles),
      raw,
      author: {
        userId: message.sender.id,
        // Relay's event carries the sender's id and kind but no display name.
        // Resolve one with `getUser(message.author.userId)` when you need it.
        userName: message.sender.id,
        fullName: message.sender.id,
        isBot: message.sender.kind === "agent",
        isMe: message.is_from_me ?? false,
        ...(message.sender.kind === "system" ? { isSystem: true } : {}),
      },
      metadata: {
        dateSent: new Date(message.created_at),
        edited: Boolean(message.edited_at),
        ...(message.edited_at ? { editedAt: new Date(message.edited_at) } : {}),
      },
      attachments,
      ...(links.length > 0 ? { links } : {}),
      // Relay delivers `message.received` to an agent only when the message is
      // addressed to it: always in a direct conversation, and in a group only
      // to agents with an invocation relationship to that message.
      isMention: true,
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RelayRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const parts = await this.buildParts(message);
    if (parts.length === 0) {
      throw new Error("a Relay message needs at least one part");
    }
    return this.sendParts(conversationId, threadId, parts);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RelayRawMessage>> {
    this.decodeThreadId(threadId);
    const parts = await this.buildParts(message);
    // Relay rejects attachment-bearing edits outright, so name that here
    // rather than letting the server answer 422 with no context.
    if (parts.some((part) => part.type === "media" || part.type === "voice_memo")) {
      throw new NotImplementedError(
        "Relay edits must stay text-bearing: media and voice memo parts are rejected",
        "editMessage",
      );
    }
    const result = await this.client.edit(messageId, parts.slice(0, MAX_PARTS_PER_MESSAGE));
    return {
      id: result.message.id,
      threadId,
      raw: { message: result.message },
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    this.decodeThreadId(threadId);
    await this.client.unsend(messageId);
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    this.decodeThreadId(threadId);
    const reaction = toRelayReaction(emoji);
    await this.client.react({ messageId, operation: "add", ...reaction });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    this.decodeThreadId(threadId);
    const reaction = toRelayReaction(emoji);
    await this.client.react({ messageId, operation: "remove", ...reaction });
  }

  /**
   * Relay's typing indicator is ephemeral and carries an optional label of up
   * to 80 characters. The invocation is peeked rather than consumed: typing is
   * not the group reply the invocation is spent on.
   */
  async startTyping(threadId: string, status?: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    const turn = this.turns.get(conversationId);
    await this.client.typing({
      conversationId,
      started: true,
      ...(status ? { label: status.slice(0, 80) } : {}),
      ...(turn?.invocationId && !turn.invocationUsed
        ? { invocationId: turn.invocationId }
        : {}),
    });
  }

  async markAsRead(threadId: string, messageId: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.client.markRead(conversationId, messageId);
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    try {
      const { user } = await this.client.user(userId);
      return {
        userId: user.id,
        userName: user.name,
        fullName: user.name,
        isBot: false,
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { status?: number }).status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Relay pages history backwards with `before_sequence` and returns newest
   * first; the Chat SDK wants each page in chronological order. There is no
   * forward cursor on the route, so `direction: "forward"` has nothing to call.
   */
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<RelayRawMessage>> {
    if (options?.direction === "forward") {
      throw new NotImplementedError(
        "Relay history pages backwards only: GET /v1/conversations/{id}/messages takes before_sequence and has no forward cursor",
        "fetchMessages",
      );
    }
    const { conversationId } = this.decodeThreadId(threadId);
    const limit = options?.limit ?? DEFAULT_HISTORY_LIMIT;
    const beforeSequence = options?.cursor ? Number(options.cursor) : undefined;
    if (beforeSequence !== undefined && !Number.isFinite(beforeSequence)) {
      throw new Error(`not a Relay history cursor: ${options?.cursor}`);
    }
    const { messages } = await this.client.history({
      conversationId,
      limit,
      ...(beforeSequence !== undefined ? { beforeSequence } : {}),
    });
    const chronological = [...messages].sort((a, b) => a.sequence - b.sequence);
    const parsed = chronological.map((message) => this.parseMessage({ message }));
    const oldest = chronological[0];
    return {
      messages: parsed,
      ...(messages.length >= limit && oldest
        ? { nextCursor: String(oldest.sequence) }
        : {}),
    };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { conversationId } = this.decodeThreadId(threadId);
    const { conversation } = await this.client.conversation(conversationId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: conversation.kind === "direct",
      // Relay conversations are private to their participants; there is no
      // workspace or externally shared scope above them.
      channelVisibility: "private",
      ...(conversation.title ??
      conversation.counterpart_user?.display_name
        ? {
            channelName:
              conversation.title ??
              (conversation.counterpart_user?.display_name as string),
          }
        : {}),
      metadata: {
        kind: conversation.kind,
        participantCount: conversation.participant_count,
        lastSequence: conversation.last_sequence,
        counterpartUserId: conversation.counterpart_user?.id,
      },
    };
  }

  /**
   * Relay commits one canonical message per turn and has no draft bubble to
   * edit, so the stream is buffered and posted once. Nothing partial ever
   * reaches a recipient, and no cleanup is needed if the stream fails midway.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<RelayRawMessage> | null> {
    const pieces: string[] = [];
    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        pieces.push(chunk);
        continue;
      }
      if (chunk.type === "markdown_text") pieces.push(chunk.text);
      // Task and plan chunks describe in-flight progress. Relay shows progress
      // through the typing label instead, so they do not enter the message.
    }
    const markdown = pieces.join("");
    if (!markdown.trim()) return null;
    return this.postMessage(threadId, { markdown });
  }

  /**
   * Verify the Standard Webhooks signature over the exact raw body, refuse a
   * replay by `event_id`, and hand the event to the Chat SDK. Relay redelivers
   * on 5xx, so a dispatch failure must not answer 2xx.
   */
  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, { error: { code: "method_not_allowed" } });
    }
    if (!this.webhookSecret) {
      throw new Error(
        "webhookSecret is required: pass it to createRelayAdapter or set RELAY_WEBHOOK_SECRET",
      );
    }
    if (!this.chat) {
      throw new Error("the Relay adapter received a webhook before initialize()");
    }

    const payload = await request.text();
    try {
      await verifyWebhookSignature({
        secret: this.webhookSecret,
        payload,
        headers: {
          "webhook-id": request.headers.get("webhook-id"),
          "webhook-timestamp": request.headers.get("webhook-timestamp"),
          "webhook-signature": request.headers.get("webhook-signature"),
        },
        options: { toleranceSeconds: this.toleranceSeconds },
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return json(401, {
          error: { code: "invalid_signature", message: error.message },
        });
      }
      throw error;
    }

    let envelope: RelayEventEnvelope;
    try {
      envelope = JSON.parse(payload) as RelayEventEnvelope;
    } catch {
      return json(422, {
        error: { code: "invalid_request", message: "body is not JSON" },
      });
    }
    if (!envelope.event_id || !envelope.event_type) {
      return json(422, {
        error: { code: "invalid_request", message: "not an event envelope" },
      });
    }
    if (this.dedupe.has(envelope.event_id)) {
      return json(200, { deduplicated: true });
    }

    await this.dispatch(envelope, options);
    this.dedupe.record(envelope.event_id);
    return json(200, { handled: true });
  }

  private async dispatch(
    envelope: RelayEventEnvelope,
    options?: WebhookOptions,
  ): Promise<void> {
    const chat = this.chat as ChatInstance;
    switch (envelope.event_type) {
      case "message.received": {
        const data = envelope.data as RelayMessageEventData;
        const raw: RelayRawMessage = {
          message: data.message,
          invocation_id: data.invocation_id,
          event_id: envelope.event_id,
          event_type: envelope.event_type,
        };
        const threadId = this.encodeThreadId({
          conversationId: data.message.conversation_id,
        });
        this.turns.set(data.message.conversation_id, {
          eventId: envelope.event_id,
          invocationId: data.invocation_id,
          invocationUsed: false,
          ordinal: 0,
        });
        await chat.processMessage(this, threadId, this.parseMessage(raw), options);
        return;
      }
      case "message.edited": {
        const data = envelope.data as RelayMessageEventData;
        const raw: RelayRawMessage = {
          message: data.message,
          event_id: envelope.event_id,
          event_type: envelope.event_type,
        };
        await chat.processMessageUpdated(
          {
            adapter: this,
            threadId: this.encodeThreadId({
              conversationId: data.message.conversation_id,
            }),
            message: this.parseMessage(raw),
          },
          options,
        );
        return;
      }
      case "message.unsent": {
        const data = envelope.data as RelayMessageUnsentEventData;
        const threadId = this.encodeThreadId({
          conversationId: data.conversation_id,
        });
        await chat.processMessageDeleted(
          {
            adapter: this,
            threadId,
            channelId: this.channelIdFromThreadId(threadId),
            messageId: data.message_id,
            deletedAt: new Date(envelope.created_at),
            raw: envelope,
          },
          options,
        );
        return;
      }
      default:
        // Reaction, receipt, conversation, and group invite events acknowledge
        // without dispatch. `reaction.added` carries an undocumented `reaction`
        // object in the OpenAPI, so there is nothing stable to map onto the
        // Chat SDK's ReactionEvent yet.
        return;
    }
  }

  private async buildParts(
    message: AdapterPostableMessage,
  ): Promise<RelayOutgoingPart[]> {
    if (typeof message === "string") {
      return this.textParts(renderRawText(message));
    }
    if (isCardElement(message)) {
      return this.textParts(renderRawText(this.cardToText(message)));
    }

    let rendered: RenderedText;
    if ("raw" in message) {
      rendered = renderRawText(message.raw);
    } else if ("markdown" in message) {
      rendered = renderMarkdown(message.markdown);
    } else if ("ast" in message) {
      rendered = renderAst(message.ast);
    } else {
      rendered = renderRawText(this.cardToText(message.card, message.fallbackText));
    }

    const parts = this.textParts(rendered);
    const attachments =
      "attachments" in message && message.attachments ? message.attachments : [];
    for (const attachment of attachments) {
      parts.push(await this.attachmentPart(attachment));
    }
    const files = "files" in message && message.files ? message.files : [];
    for (const file of files) {
      parts.push(await this.filePart(file));
    }
    return parts;
  }

  private textParts(rendered: RenderedText): RelayOutgoingPart[] {
    return chunkRenderedText(rendered, MAX_TEXT_PART_BYTES).map((chunk) => ({
      type: "text" as const,
      text: chunk.text,
      // An empty array is meaningful to Relay: it marks structured plain text
      // rather than a legacy Markdown body.
      styles: chunk.styles,
    }));
  }

  /**
   * Relay has no card surface: interactive components were removed from the
   * app, so buttons cannot render and a human cannot answer one in Relay. The
   * card's words are still delivered, as text, rather than dropped.
   */
  private cardToText(card: CardElement, fallbackText?: string): string {
    if (fallbackText?.trim()) return fallbackText;
    const lines: string[] = [];
    if (card.title) lines.push(card.title);
    if (card.subtitle) lines.push(card.subtitle);
    for (const child of card.children ?? []) {
      const rendered = cardChildToFallbackText(child);
      if (rendered) lines.push(rendered);
    }
    const value = lines.join("\n\n").trim();
    if (!value) {
      throw new NotImplementedError(
        "Relay has no card surface and this card carried no text to fall back to",
        "postMessage",
      );
    }
    return value;
  }

  private async attachmentPart(
    attachment: Attachment,
  ): Promise<RelayOutgoingPart> {
    if (attachment.url?.startsWith("https://")) {
      return {
        type: "media",
        url: attachment.url,
        ...(attachment.mimeType ? { content_type: attachment.mimeType } : {}),
      };
    }
    const data = attachment.data ?? (await attachment.fetchData?.());
    if (!data) {
      throw new Error(
        `attachment ${attachment.name ?? "(unnamed)"} has neither an https URL nor bytes, so Relay has nothing to store`,
      );
    }
    const stored = await this.client.upload({
      body: await toBytes(data),
      ...(attachment.mimeType ? { contentType: attachment.mimeType } : {}),
      ...(attachment.name ? { filename: attachment.name } : {}),
    });
    return { type: "media", attachment_id: stored.id };
  }

  private async filePart(file: FileUpload): Promise<RelayOutgoingPart> {
    const stored = await this.client.upload({
      body: await toBytes(file.data),
      ...(file.mimeType ? { contentType: file.mimeType } : {}),
      filename: file.filename,
    });
    return { type: "media", attachment_id: stored.id };
  }

  /**
   * Send the parts as one message when they fit, and as follow-up messages
   * when they do not. A group turn cannot overflow: Relay's invocation is
   * single use, so a second message has nothing valid to cite.
   */
  private async sendParts(
    conversationId: string,
    threadId: string,
    parts: RelayOutgoingPart[],
  ): Promise<RawMessage<RelayRawMessage>> {
    const turn = this.turns.get(conversationId);
    const batches: RelayOutgoingPart[][] = [];
    for (let i = 0; i < parts.length; i += MAX_PARTS_PER_MESSAGE) {
      batches.push(parts.slice(i, i + MAX_PARTS_PER_MESSAGE));
    }
    const invocationId =
      turn?.invocationId && !turn.invocationUsed ? turn.invocationId : undefined;
    if (batches.length > 1 && invocationId) {
      throw new Error(
        `this reply needs ${batches.length} Relay messages, and a group invocation authorizes exactly one`,
      );
    }

    let first: RawMessage<RelayRawMessage> | undefined;
    for (const batch of batches) {
      const ordinal = turn ? turn.ordinal++ : 0;
      const idempotencyKey = turn
        ? await deriveIdempotencyKey(turn.eventId, ordinal, batch)
        : unkeyedIdempotencyKey(conversationId);
      const result = await this.client.send({
        conversationId,
        parts: batch,
        idempotencyKey,
        ...(first === undefined && invocationId ? { invocationId } : {}),
      });
      if (first === undefined && invocationId && turn) turn.invocationUsed = true;
      first ??= {
        id: result.message_id,
        threadId,
        raw: { message: result.message },
      };
    }
    return first as RawMessage<RelayRawMessage>;
  }
}

/** Build a Relay adapter for the Vercel Chat SDK. */
export function createRelayAdapter(
  options: RelayAdapterOptions = {},
): RelayAdapter {
  return new RelayAdapter(options);
}

export type { RelayMessage };
