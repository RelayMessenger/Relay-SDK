/**
 * Relay v1 wire types used by this adapter.
 *
 * Contract source:
 * Relay Server 3b7425e5bafcf25cdc8ceff009715e4f06877d18
 * OpenAPI 3fb4873a3c09b7dade09012ecfc57acfef8cfb983b6b35fff9d320cf62bb3b00
 */

export const RELAY_API_VERSION = "v1" as const;
export const RELAY_WEBHOOK_VERSION = "2026-08-30" as const;

export const RELAY_WEBHOOK_EVENT_TYPES = [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "message.failed",
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
  "call.created",
  "call.updated",
  "call.ended",
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

export interface RelayChatActivity {
  id: string;
  text: string;
  emoji: string | null;
  updated_at: string;
  expires_at: string;
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
  /** True when the caller holds this Handle as a Contact. */
  is_contact: boolean;
  activity_version?: string;
  activity?: RelayChatActivity | null;
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

/** One button under a message: a label, and for a link button, the page it opens. */
export interface RelayButtonItem {
  label: string;
  url?: string;
}

/** Agent-only: 1 to 5 buttons under the message; a tap comes back as text equal to the label. */
export interface RelayButtonsPart {
  type: "buttons";
  items: RelayButtonItem[];
}

/** Values are stable ASCII tokens, independent of trimmed labels. */
export interface RelaySelectionPart {
  type: "selection";
  options: Array<{ value: string; label: string }>;
}

export interface RelayButtonsPartResponse extends RelayButtonsPart {
  reactions?: RelayReaction[] | null;
}

export interface RelaySelectionPartResponse extends RelaySelectionPart {
  readonly has_responded: boolean;
  /** The values the authenticated viewer chose, in source-option order, identical on every one of that user's devices; null until the viewer answers, when the answer Message no longer exists, and always for an agent viewer. */
  readonly selected_values: string[] | null;
  reactions: null;
}

/** Metadata exposed intact through message.raw.message.parts.
 * Readable text is literal '• ' + each selected source label joined with '\n'.
 * Dispatch with selected_values and reply_to, never by parsing visible labels. */
export interface RelaySelectionResponsePart {
  type: "selection_response";
  selected_values: string[];
}

/** Stripe's own recurring shape: interval plus how many of it. */
export interface RelayInvoiceRecurring {
  interval: "day" | "week" | "month" | "year";
  /** Defaults to 1. Total span is capped at 3 years (1095 days / 156 weeks / 36 months / 3 years). */
  interval_count?: number;
}

export type RelayInvoiceStatus =
  | "requested"
  | "succeeded"
  | "canceled"
  | "expired"
  | "refunded";

/**
 * Verified agents only: asks the person to pay through the developer's own
 * Stripe-hosted checkout page. Must be the only part of its Message.
 */
export interface RelayInvoicePart {
  type: "invoice";
  /** Trimmed, 1–32 characters. */
  title: string;
  /** Minor units, 1..99,999,999. */
  amount: number;
  /** 3-letter ISO code, sent in either case, returned lowercase. */
  currency: string;
  /** physical = goods or services used outside the app; digital = anything delivered in chat or used in an app. */
  goods: "physical" | "digital";
  /** https on checkout, buy, book, donate or invoice.stripe.com, with no port, username or password; at most 2048 characters. */
  url: string;
  /** Omit for a one-time charge. */
  recurring?: RelayInvoiceRecurring;
}

/** Metadata exposed intact through message.raw.message.parts; contributes no readable text. */
export interface RelayInvoicePartResponse extends RelayInvoicePart {
  recurring?: Required<RelayInvoiceRecurring>;
  /** "requested" until the sending agent's own status update changes it. */
  status: RelayInvoiceStatus;
  reactions: RelayReaction[] | null;
}

export type RelayOutgoingPart =
  | RelayTextPart
  | RelayMediaPart
  | RelayLinkPart
  | RelayButtonsPart
  | RelaySelectionPart
  | RelayInvoicePart;

export interface RelayTextPartResponse extends RelayTextPart {
  mentions?: Array<{
    id: string;
    handle: string;
    is_me: boolean;
    range: [number, number];
  }> | null;
  /** @deprecated Use mentions instead. */
  mention?: string | null;
  /** @deprecated Use mentions instead. */
  mention_range?: [number, number] | null;
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
  | RelaySystemPartResponse
  | RelayButtonsPartResponse
  | RelaySelectionPartResponse
  | RelaySelectionResponsePart
  | RelayInvoicePartResponse;

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
  silent?: boolean;
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
    | RelayTextPartResponse
    | RelayMediaPartResponse
    | RelayLinkPartResponse
    | RelayButtonsPartResponse
    | RelaySelectionPartResponse
    | RelaySelectionResponsePart
    | RelayInvoicePartResponse
  >;
  read_at?: string | null;
  reply_to?: RelayReplyTo | null;
  sender_handle: RelayChatHandle;
  sent_at?: string | null;
  silent?: boolean;
}

export interface RelaySentMessage {
  created_at: string;
  delivered_at?: string | null;
  delivery_status: "sent" | "delivered" | "read";
  from_handle?: RelayChatHandle | null;
  id: string;
  parts: Array<
    | RelayTextPartResponse
    | RelayMediaPartResponse
    | RelayLinkPartResponse
    | RelayButtonsPartResponse
    | RelaySelectionPartResponse
    | RelaySelectionResponsePart
    | RelayInvoicePartResponse
  >;
  reply_to?: RelayReplyTo | null;
  sent_at: string | null;
  silent?: boolean;
}

/** `PUT /v1/messages/{messageId}/invoice`: the updated Message projection. */
export interface RelayUpdateInvoiceStatusResponse {
  message: RelayMessage;
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
