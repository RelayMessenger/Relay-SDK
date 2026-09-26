/**
 * Relay v1 wire types used by this adapter.
 *
 * Contract source:
 * Relay Server e53138b79536f2fb8bbd339e6d344819c0afe8ff
 * OpenAPI 3ac33f08a16f83be44585a34df34d7067f9157a8971e63686ab41f44374ce5f8
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
  "payment.succeeded",
  "payment.canceled",
  "payment.expired",
  "location.sharing.started",
  "location.sharing.stopped",
  "task.created",
  "task.message",
  "task.canceled",
  "task.updated",
  "community.post.created",
  "community.comment.created",
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
  subtitle: string | null;
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

/** Values are stable ASCII tokens, independent of trimmed labels. A text part is optional and shows as an ordinary bubble above the card. */
export interface RelaySelectionPart {
  type: "selection";
  /** The question: the card's title and the sheet's title. Trimmed, 1–60 characters. */
  title: string;
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

/** What is being paid for; App Store rules decide where each is payable. */
export type RelayPaymentCategory = "physical_goods" | "digital_goods" | "donation";

/** Leaves `requested` exactly once, only on Stripe's word or the agent's cancel. */
export type RelayPaymentStatus = "requested" | "succeeded" | "canceled" | "expired";

export type RelayPaymentMode = "payment" | "subscription";

/** A subscription's renewal cadence, read from its Stripe Price. */
export interface RelayPaymentRecurring {
  interval: "day" | "week" | "month" | "year";
  interval_count: number;
}

/**
 * A payment card: the `checkout_url` a payment request returned, unchanged.
 * The card's amount and title are read from the request. Must be the only
 * part of its Message.
 */
export interface RelayPaymentPart {
  type: "payment";
  checkout_url: string;
}

/** Metadata exposed intact through message.raw.message.parts; contributes no readable text. */
export interface RelayPaymentPartResponse {
  type: "payment";
  payment_request_id: string;
  checkout_url: string;
  amount: number;
  currency: string;
  description: string;
  category: RelayPaymentCategory;
  mode: RelayPaymentMode;
  recurring?: RelayPaymentRecurring;
  image_url?: string;
  status: RelayPaymentStatus;
  reactions: RelayReaction[] | null;
}

/** The payer's receipt, written only by Relay as a reply to the `payment` card; contributes no readable text. */
export interface RelayPaymentReceiptPartResponse {
  type: "payment_receipt";
  payment_request_id: string;
  description: string;
  amount: number;
  currency: string;
  mode: RelayPaymentMode;
  recurring?: RelayPaymentRecurring;
  reactions: RelayReaction[] | null;
}

/** An agent's request for the person's location; carries no text and cannot be sent as a part. */
export interface RelayLocationRequestPartResponse {
  type: "location_request";
  reactions: RelayReaction[] | null;
}

/** A person's location share card: its state, never its position. */
export interface RelayLocationPartResponse {
  type: "location";
  state: "live" | "ended";
  began_at: string | null;
  ends_at: string | null;
  ended_at: string | null;
  reactions: RelayReaction[] | null;
}

/** `POST /v1/payment_requests`. */
export interface RelayCreatePaymentRequest {
  amount?: number;
  currency?: string;
  /** The card's title line; trimmed, 1 to 32 characters. */
  description: string;
  category: RelayPaymentCategory;
  metadata?: Record<string, string>;
  mode?: RelayPaymentMode;
  price_id?: string;
  quantity?: number;
  customer_id?: string;
  discount?: { coupon?: string; promotion_code?: string; label?: string };
  image_url?: string;
}

export interface RelayPaymentRequest {
  id: string;
  object: "payment_request";
  status: RelayPaymentStatus;
  mode: RelayPaymentMode;
  amount: number;
  /** Relay's 5% fee in minor units. */
  application_fee_amount: number;
  currency: string;
  description: string;
  category: RelayPaymentCategory;
  /** Send it back unchanged in a `payment` part. */
  checkout_url: string;
  expires_at: string;
  metadata: Record<string, string>;
  image_url?: string;
  price_id?: string;
  quantity?: number;
  interval?: RelayPaymentRecurring["interval"];
  interval_count?: number;
  discount?: { coupon?: string; promotion_code?: string; label?: string };
  stripe: { payment_intent_id: string; customer_id?: string; subscription_id?: string };
  paid_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RelayPaymentRequestList {
  payment_requests: RelayPaymentRequest[];
  next_cursor: string | null;
}

export type RelayOutgoingPart =
  | RelayTextPart
  | RelayMediaPart
  | RelayLinkPart
  | RelayButtonsPart
  | RelaySelectionPart
  | RelayPaymentPart;

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
  | RelayPaymentPartResponse
  | RelayPaymentReceiptPartResponse
  | RelayLocationRequestPartResponse
  | RelayLocationPartResponse;

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
    | RelayPaymentPartResponse
    | RelayPaymentReceiptPartResponse
    | RelayLocationRequestPartResponse
    | RelayLocationPartResponse
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
    | RelayPaymentPartResponse
    | RelayPaymentReceiptPartResponse
    | RelayLocationRequestPartResponse
    | RelayLocationPartResponse
  >;
  reply_to?: RelayReplyTo | null;
  sent_at: string | null;
  silent?: boolean;
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
