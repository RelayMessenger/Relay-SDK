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

/** Outgoing part shapes accepted by `POST /v1/messages`. */
export type RelayOutgoingPart =
  | { type: "text"; text: string }
  | { type: "media"; attachment_id?: string; url?: string }
  | { type: "voice_memo"; attachment_id?: string; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string }
  | { type: "data"; data: Record<string, unknown> };

/** Stored canonical part as delivered in events and history. */
export type RelayPart = {
  type: string;
  part_index?: number;
  text?: string;
  url?: string;
  attachment_id?: string;
  duration_ms?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: RelayMessageSender;
  parts: RelayPart[];
  reply_to?: { message_id: string; part_index?: number } | null;
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

export interface SendResult {
  message_id: string;
  message: RelayMessage;
}

export interface StreamSendResult extends SendResult {
  stream: {
    protocol: "vercel-ai-ui-message-stream-v1";
    source_message_id?: string;
    finish_reason?: string;
  };
}

/**
 * Anything that can yield a Vercel AI SDK UI message stream: the SSE
 * `Response` from `toUIMessageStreamResponse()`, its `ReadableStream` body,
 * or a result object exposing `toUIMessageStreamResponse()` directly
 * (e.g. `streamText(...)`).
 */
export type UIMessageStreamSource =
  | Response
  | ReadableStream<Uint8Array>
  | { toUIMessageStreamResponse(init?: unknown): Response };
