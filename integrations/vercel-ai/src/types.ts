/**
 * Wire types for the Relay v1 developer API, scoped to what this plugin
 * consumes and produces. Contract: https://docs.relayapp.im/reference/events
 * and the live OpenAPI document. The part discriminator is `type`.
 */

export interface RelayEventEnvelope<TData = unknown> {
  event_id: string;
  event_type: string;
  agent_id: string;
  created_at: string;
  data: TData;
}

export interface RelayMessageSender {
  kind: "user" | "agent" | "system";
  id: string;
  display_name?: string;
}

/**
 * Inline mention of a conversation participant. Offsets are UTF-16 code
 * units into the part's `text`, which holds the inserted display name with
 * no "@". Ranges are sorted by `start` and never overlap.
 */
export interface RelayMentionRange {
  start: number;
  length: number;
  participant_id: string;
}

export type RelayTextStyle = "bold" | "italic" | "underline" | "strikethrough" | "monospace" | "spoiler";

/**
 * One formatting run over a text part, offsets in UTF-16 code units like
 * mentions. An EMPTY `styles` array on the part is meaningful: it marks
 * structured plain text as opposed to a legacy Markdown body.
 */
export interface RelayStyleRange {
  start: number;
  length: number;
  styles: RelayTextStyle[];
}

/** Outgoing part shapes accepted by `POST /v1/messages`. */
export type RelayOutgoingPart =
  | { type: "text"; text: string; mentions?: RelayMentionRange[]; styles?: RelayStyleRange[] }
  | {
      type: "media";
      attachment_id?: string;
      url?: string;
      /** Optional pixel dimensions, always provided together. */
      width?: number;
      height?: number;
      /** Optional blurhash placeholder (base83). Derived by the server for
       * image attachments when omitted. */
      blur_hash?: string;
    }
  | { type: "voice_memo"; attachment_id?: string; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string }
  | { type: "data"; data: Record<string, unknown> };

/** Stored canonical part as delivered in events and history. */
export type RelayPart = {
  type: string;
  part_index?: number;
  text?: string;
  mentions?: RelayMentionRange[];
  styles?: RelayStyleRange[];
  url?: string;
  attachment_id?: string;
  duration_ms?: number;
  width?: number;
  height?: number;
  blur_hash?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: RelayMessageSender;
  parts: RelayPart[];
  reply_to?: { message_id: string } | null;
  reactions?: unknown[];
  fallback_text?: string;
  status?: string;
  created_at: string;
}

export interface MessageReceivedData {
  message: RelayMessage;
  invocation_id?: string;
}

export type MessageReceivedEvent = RelayEventEnvelope<MessageReceivedData>;

/**
 * The 202 from `POST /v1/messages`. The server splits the accepted parts at
 * ingest: each visible non-media part becomes its own message and contiguous
 * media parts stay one media message, so one send commits one or more
 * messages, in display order.
 */
export interface SendResult {
  messages: RelayMessage[];
}

export interface StreamSendResult extends SendResult {
  stream: {
    protocol: "vercel-ai-ui-message-stream-v1";
    source_message_id?: string;
    finish_reason?: string;
  };
}

/**
 * Anything that can yield a Vercel AI SDK UI message stream:
 *
 * - a `ReadableStream` of UI message chunk OBJECTS, which is what the
 *   standalone `toUIMessageStream({ stream: result.stream })` helper returns
 *   on ai@7. The client SSE-encodes each chunk and appends the terminator,
 *   matching what `createUIMessageStreamResponse` writes on the wire.
 * - a `ReadableStream<Uint8Array>` already carrying SSE bytes, e.g. the body
 *   of an SSE `Response`. Forwarded untouched.
 * - an SSE `Response`.
 * - a result object exposing the DEPRECATED `toUIMessageStreamResponse()`
 *   (e.g. `streamText(...)` on ai@7). Kept so existing callers keep working.
 */
export type UIMessageStreamSource =
  | Response
  | ReadableStream<Uint8Array>
  | ReadableStream<unknown>
  | { toUIMessageStreamResponse(init?: unknown): Response };
