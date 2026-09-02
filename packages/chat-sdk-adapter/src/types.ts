/**
 * Relay v1 wire types used by this adapter.
 *
 * Contract source:
 * Relay Server 13c92e5a131c8d34ab4615e097a91b3426e730ed
 * OpenAPI 622095a7990cfb43576f0d6b76f5ab4a358f0fd23483ce11e1f02a909d957abd
 */

export const RELAY_API_VERSION = "v1" as const;
export const RELAY_WEBHOOK_VERSION = "2026-08-30" as const;

export const RELAY_WEBHOOK_EVENT_TYPES = [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "reaction.added",
  "reaction.removed",
  "participant.added",
  "participant.removed",
  "chat.created",
  "chat.group_name_updated",
  "chat.group_icon_updated",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
  "contact.added",
  "contact.removed",
] as const;

export type RelayWebhookEventType =
  (typeof RELAY_WEBHOOK_EVENT_TYPES)[number];

export interface RelayWebhookEnvelope<TData = Record<string, unknown>> {
  agent_id: string;
  api_version: typeof RELAY_API_VERSION;
  created_at: string;
  data: TData;
  event_id: string;
  event_type: RelayWebhookEventType;
  trace_id: string;
  webhook_version: typeof RELAY_WEBHOOK_VERSION;
}

export interface RelayChatHandle {
  image_url: string | null;
  display_name: string | null;
  handle: string;
  id: string;
  is_me?: boolean | null;
  joined_at: string;
  kind: "user" | "agent";
  left_at?: string | null;
  status?: "active" | "left" | "removed" | null;
  about: string | null;
  verified: boolean;
}

export type RelayReactionType =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | "custom";

export interface RelayReaction {
  custom_emoji?: string | null;
  handle: RelayChatHandle;
  is_me: boolean;
  type: RelayReactionType;
}

export interface RelayTextPart {
  mention?: string | null;
  mention_range?: [number, number] | null;
  type: "text";
  value: string;
}

export interface RelayMediaPart {
  attachment_id?: string;
  type: "media";
  url?: string;
}

export interface RelayLinkPart {
  type: "link";
  value: string;
}

export type RelayOutgoingPart =
  | RelayTextPart
  | RelayMediaPart
  | RelayLinkPart;

export interface RelayTextPartResponse extends RelayTextPart {
  reactions?: RelayReaction[] | null;
}

export interface RelayMediaPartResponse {
  duration_ms?: number | null;
  filename: string;
  height?: number | null;
  id: string;
  mime_type: string;
  reactions?: RelayReaction[] | null;
  size_bytes: number;
  type: "media";
  url: string;
  width?: number | null;
}

export interface RelayLinkPartResponse extends RelayLinkPart {
  reactions?: RelayReaction[] | null;
}

export interface RelaySystemPartResponse {
  reactions?: RelayReaction[] | null;
  type: "system";
  value: string;
}

export type RelayMessagePartResponse =
  | RelayTextPartResponse
  | RelayMediaPartResponse
  | RelayLinkPartResponse
  | RelaySystemPartResponse;

export interface RelayReplyTo {
  message_id: string;
  part_index?: number;
}

export interface RelayMessage {
  chat_id: string;
  created_at: string;
  delivered_at?: string | null;
  delivery_status: "sent" | "delivered" | "read";
  from?: string | null;
  from_handle?: RelayChatHandle | null;
  id: string;
  is_from_me: boolean;
  is_system_message: boolean;
  parts?: RelayMessagePartResponse[] | null;
  read_at?: string | null;
  reply_to?: RelayReplyTo | null;
  sent_at?: string | null;
  system_event?: Record<string, unknown> | null;
  updated_at: string;
}

export interface RelayWebhookMessageEvent {
  chat: {
    id: string;
    is_group?: boolean | null;
    owner_handle?: RelayChatHandle | null;
  };
  delivered_at?: string | null;
  direction: "inbound" | "outbound";
  id: string;
  idempotency_key?: string | null;
  parts: Array<
    RelayTextPartResponse | RelayMediaPartResponse | RelayLinkPartResponse
  >;
  read_at?: string | null;
  reply_to?: RelayReplyTo | null;
  sender_handle: RelayChatHandle;
  sent_at?: string | null;
}

export interface RelaySentMessage {
  created_at: string;
  delivered_at?: string | null;
  delivery_status: "sent" | "delivered" | "read";
  from_handle?: RelayChatHandle | null;
  id: string;
  parts: Array<
    RelayTextPartResponse | RelayMediaPartResponse | RelayLinkPartResponse
  >;
  reply_to?: RelayReplyTo | null;
  sent_at: string | null;
}

export interface RelaySendMessageResponse {
  chat_id: string;
  message: RelaySentMessage;
}

export interface RelayGetMessagesResult {
  messages: RelayMessage[];
  next_cursor?: string | null;
}

export interface RelayChat {
  created_at: string;
  display_name: string | null;
  group_chat_icon?: string | null;
  handles: RelayChatHandle[];
  id: string;
  is_group: boolean;
  updated_at: string;
}

export interface RelayReactionEvent {
  chat_id: string;
  custom_emoji?: string | null;
  from_handle: RelayChatHandle;
  is_from_me: boolean;
  message_id: string;
  part_index: number;
  reacted_at: string;
  reaction_type: RelayReactionType;
}

/**
 * `GET /v1/attachments/{attachmentId}` metadata. `download_url` is optional in
 * the locked v1 contract, so a caller must handle its absence.
 */
export interface RelayAttachment {
  content_type: string;
  created_at: string;
  download_url?: string;
  duration_ms?: number | null;
  filename: string;
  height?: number | null;
  id: string;
  size_bytes: number;
  status: "pending" | "complete" | "failed";
  width?: number | null;
}

export interface RelayAttachmentAllocation {
  attachment_id: string;
  download_url: string;
  expires_at: string;
  http_method: "PUT";
  required_headers: Record<string, string>;
  upload_url: string;
}

export interface RelayRawMessage {
  chatId: string;
  createdAt?: string;
  eventId?: string;
  eventType?: RelayWebhookEventType;
  message:
    | RelayMessage
    | RelaySentMessage
    | RelayWebhookMessageEvent
    | null;
  /** Synthetic Chat SDK result for an intentionally empty no-op post. */
  noop?: true;
}

/** Platform data encoded by `relay:<chat UUID>`. */
export interface RelayThreadId {
  chatId: string;
}
