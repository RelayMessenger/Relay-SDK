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
import {
  decodeWebhookSecret,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "./signature.js";
import {
  decodeRelayThreadId,
  encodeRelayThreadId,
  relayChannelIdFromThreadId,
} from "./threadId.js";
import { activeTurn, runInTurn, type RelayTurn } from "./turn.js";
import type {
  RelayEventEnvelope,
  RelayMessage,
  RelayMessageEventData,
  RelayMessageUnsentEventData,
  RelayOutgoingPart,
  RelayPart,
  RelayRawMessage,
  RelayStyleRange,
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

/** `GET /v1/conversations/{id}/messages` clamps `limit` to this server side. */
const MAX_HISTORY_LIMIT = 100;

/**
 * A group turn tried to commit a second message. Relay's invocation is single
 * use, so there is nothing valid for the second message to cite and the server
 * would answer 403.
 */
export class RelayInvocationSpentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayInvocationSpentError";
  }
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

/** Text parts joined into one string, with every style range rebased onto it. */
const TEXT_PART_SEPARATOR = "\n\n";

/**
 * Flatten a message's text parts into the single string the Chat SDK reads,
 * carrying each part's style ranges across at their new offsets.
 *
 * A message routinely holds several text parts: this adapter itself produces
 * them whenever a reply is longer than Relay's 8 KB per-part ceiling. Reading
 * only the first part's ranges would land a chunked reply back as one flat
 * paragraph, and applying them to the joined string unshifted would put the
 * emphasis on the wrong words.
 */
function joinTextParts(parts: RelayPart[]): {
  text: string;
  styles: RelayStyleRange[];
} {
  const pieces: string[] = [];
  const styles: RelayStyleRange[] = [];
  let offset = 0;
  for (const part of parts) {
    const text = part.text ?? "";
    // An empty part contributes no text, so it must not contribute a separator
    // either: that would shift every later range by two.
    if (!text) continue;
    if (pieces.length > 0) offset += TEXT_PART_SEPARATOR.length;
    for (const run of part.styles ?? []) {
      styles.push({
        start: run.start + offset,
        length: run.length,
        styles: run.styles,
      });
    }
    pieces.push(text);
    offset += text.length;
  }
  return { text: pieces.join(TEXT_PART_SEPARATOR), styles };
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
    // Decode once, here. An unusable secret raised from inside verification is
    // a 500 on every delivery, and Relay reads a 500 as transient and
    // redelivers ten times; raised here it is a startup failure naming the
    // option that is wrong.
    if (this.webhookSecret) decodeWebhookSecret(this.webhookSecret);
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
    const joined = joinTextParts(textParts);
    const value = joined.text || message.fallback_text || "";
    // Ranges index into the joined part text. When the parts carried no text
    // and the fallback stands in, they would index into a different string.
    const styles = joined.text ? joined.styles : undefined;

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
    // Relay accepts exactly one text part per edit: an edit replaces one
    // message's text, and one text part carries at most 8 KB. Text long
    // enough to chunk cannot be an edit of one message, so refuse it here
    // rather than sending a multi-part PATCH the server answers 422 to, or
    // silently truncating the caller's content.
    if (parts.length !== 1) {
      throw new NotImplementedError(
        "a Relay edit replaces one message with one text part of at most 8 KB; shorten the edit or post a new message",
        "editMessage",
      );
    }
    const result = await this.client.edit(messageId, parts);
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
   *
   * Failures are swallowed. Group typing without a live pending invocation is a
   * 403 (`Relay-Server/server/src/domain/typing.ts:70-73`), which is exactly
   * what typing after the first send of a group turn looks like. The Chat SDK
   * treats this call as best effort and has no `stopTyping` to strand, so a
   * hint that cannot be shown must never take the reply down with it.
   */
  async startTyping(threadId: string, status?: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    const turn = activeTurn(conversationId);
    try {
      await this.client.typing({
        conversationId,
        started: true,
        ...(status ? { label: status.slice(0, 80) } : {}),
        ...(turn?.invocationId && !turn.invocationUsed
          ? { invocationId: turn.invocationId }
          : {}),
      });
    } catch {
      // The indicator is decoration. The turn continues.
    }
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
    // The route clamps `limit` to 1..100 server side
    // (`Relay-Server/server/src/routes/messages.ts:418`). Asking for 200 and
    // then testing the 100 rows that come back against 200 would read as "the
    // conversation ended here" and silently truncate the history.
    const limit = Math.min(
      Math.max(Math.trunc(options?.limit ?? DEFAULT_HISTORY_LIMIT), 1),
      MAX_HISTORY_LIMIT,
    );
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
    // Claim before dispatching, not after. Two redeliveries of one event can
    // be in flight at once, and a check that only records on the way out lets
    // both of them past.
    if (!this.dedupe.claim(envelope.event_id)) {
      return json(200, { deduplicated: true });
    }

    try {
      await this.dispatch(envelope, options);
    } catch (error) {
      // Give the claim back. A thrown handler answers 5xx, which is Relay's
      // signal to redeliver, and a retained claim would turn every redelivery
      // into a 200 that did nothing: the message would be lost outright. The
      // `Idempotency-Key` on each send is what keeps the retry from posting
      // twice whatever the first attempt already committed.
      this.dedupe.release(envelope.event_id);
      throw error;
    }
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
        const turn: RelayTurn = {
          conversationId: data.message.conversation_id,
          eventId: envelope.event_id,
          invocationId: data.invocation_id,
          invocationUsed: false,
          sent: 0,
        };
        // Bind the turn to this dispatch's async context, so a second event on
        // the same conversation cannot take it over while this one waits.
        await runInTurn(turn, () =>
          chat.processMessage(this, threadId, this.parseMessage(raw), options),
        );
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
   * Send the parts in one call when they fit, and as follow-up calls when
   * they do not. The server splits each call at ingest into one or more
   * messages, and the one call that carries the invocation owns every message
   * it commits. A group turn cannot overflow, and cannot POST twice: Relay's
   * invocation is single use per call, so a second POST has nothing valid to
   * cite and the server answers 403.
   */
  private async sendParts(
    conversationId: string,
    threadId: string,
    parts: RelayOutgoingPart[],
  ): Promise<RawMessage<RelayRawMessage>> {
    const turn = activeTurn(conversationId);
    const batches: RelayOutgoingPart[][] = [];
    for (let i = 0; i < parts.length; i += MAX_PARTS_PER_MESSAGE) {
      batches.push(parts.slice(i, i + MAX_PARTS_PER_MESSAGE));
    }
    // Relay carries an invocation only on a group event, so a turn holding one
    // is a group turn for as long as it lives. Test that rather than testing
    // whether an invocation is still available: once it is spent, the second
    // send would otherwise go out bare and be refused by the server.
    const groupTurn = turn?.invocationId !== undefined ? turn : undefined;
    if (groupTurn?.invocationUsed) {
      throw new RelayInvocationSpentError(
        "this group turn already replied, and one Relay invocation permits one message",
      );
    }
    const invocationId = groupTurn?.invocationId;
    if (batches.length > 1 && invocationId) {
      throw new RelayInvocationSpentError(
        `this reply needs ${batches.length} Relay send calls, and one Relay invocation permits one call`,
      );
    }

    // The ordinal is the send's logical position in the turn, so a retry lands
    // on the key the first attempt used and Relay replays it instead of
    // posting a second message. The base counts what this turn has already
    // committed and is read once, before the loop: it advances only on a
    // successful send, so an attempt that threw does not push the next key
    // along and a redelivery of the whole event starts from zero again.
    const base = turn?.sent ?? 0;

    let first: RawMessage<RelayRawMessage> | undefined;
    for (const [index, batch] of batches.entries()) {
      const idempotencyKey = turn
        ? deriveIdempotencyKey(turn.eventId, base + index)
        : unkeyedIdempotencyKey(conversationId);
      const result = await this.client.send({
        conversationId,
        parts: batch,
        idempotencyKey,
        ...(first === undefined && invocationId ? { invocationId } : {}),
      });
      if (turn) {
        turn.sent += 1;
        if (first === undefined && invocationId) turn.invocationUsed = true;
      }
      // One call commits one or more messages; the Chat SDK's post contract
      // names a single raw message, so the first committed one stands for the
      // whole send.
      const [committed] = result.messages;
      if (committed && first === undefined) {
        first = {
          id: committed.id,
          threadId,
          raw: { message: committed },
        };
      }
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
