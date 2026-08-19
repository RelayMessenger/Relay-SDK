/**
 * Wire types for the Relay v1 developer API, scoped to what this adapter
 * consumes and produces. The authoritative contract is the published OpenAPI
 * document at https://docs.relayapp.im/api-reference. The part discriminator
 * is `type`.
 */

export interface RelayEventEnvelope<TData = unknown> {
  event_id: string;
  event_type: string;
  agent_id: string;
  created_at: string;
  data: TData;
}

export interface RelaySender {
  kind: "user" | "agent" | "system";
  id: string;
}

/**
 * Inline mention of a conversation participant. Offsets are UTF-16 code units
 * into the part's `text`, which holds the inserted display name with no "@".
 * Ranges are sorted by `start` and never overlap.
 */
export interface RelayMentionRange {
  start: number;
  length: number;
  participant_id: string;
}

export type RelayTextStyle =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "monospace"
  | "spoiler";

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
  | {
      type: "text";
      text: string;
      mentions?: RelayMentionRange[];
      styles?: RelayStyleRange[];
    }
  | {
      type: "media";
      attachment_id?: string;
      url?: string;
      content_type?: string;
    }
  | { type: "voice_memo"; attachment_id?: string; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string; title?: string; description?: string }
  | { type: "data"; data: Record<string, unknown> };

/** Stored canonical part as delivered in events and history. */
export interface RelayPart {
  type: string;
  part_index?: number;
  text?: string;
  mentions?: RelayMentionRange[];
  styles?: RelayStyleRange[];
  url?: string;
  attachment_id?: string;
  content_type?: string;
  media_kind?: "image" | "video" | "audio" | "file";
  filename?: string;
  size_bytes?: number;
  duration_ms?: number;
  width?: number;
  height?: number;
  blur_hash?: string;
  title?: string;
  description?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A message as Relay projects it for this agent. A tombstone carries no
 * `parts`, so every reader must treat that field as optional.
 */
export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: RelaySender;
  is_from_me?: boolean;
  parts?: RelayPart[];
  reply_to?: { message_id?: string; part_index?: number } | null;
  invoked_agents?: string[];
  reactions?: unknown[];
  fallback_text?: string;
  status: string;
  delivered_at?: string;
  read_at?: string;
  edited_at?: string;
  unsent_at?: string;
  created_at: string;
}

export interface RelayMessageEventData {
  message: RelayMessage;
  invocation_id?: string;
}

export interface RelayMessageUnsentEventData {
  message_id: string;
  conversation_id: string;
  sequence: number;
}

export interface RelaySendResult {
  message_id: string;
  message: RelayMessage;
}

export interface RelayConversation {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  counterpart_user: {
    id: string;
    display_name: string;
    avatar_url: string | null;
  } | null;
  participant_count: number;
  last_sequence: number;
  last_message_at: string | null;
  created_at: string;
}

export interface RelayUserProfile {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone_number: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface RelayAttachment {
  id: string;
  url: string;
  content_type: string;
  size_bytes: number;
}

/**
 * Relay carries one reaction kind. The field survives because the wire still
 * names it, not because there is a choice to make.
 */
export type RelayReactionType = "emoji";

/**
 * The raw payload this adapter hands to the Chat SDK. It carries the group
 * invocation id alongside the message because Relay scopes a group reply to
 * the invocation that produced the inbound event, and `Adapter.postMessage`
 * never sees the event.
 */
export interface RelayRawMessage {
  message: RelayMessage;
  invocation_id?: string;
  event_id?: string;
  event_type?: string;
}

/** Platform-specific data behind a Relay thread id. */
export interface RelayThreadId {
  conversationId: string;
}
