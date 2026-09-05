import type { RELAY_WEBHOOK_EVENT_TYPES } from "./operations.js";

export type UUID = string;

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
  headers?: HeadersInit;
}

export type DeliveryStatus =
  | "sent"
  | "delivered"
  | "read";

export type ReactionType =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | "custom";

interface ChatHandleBase {
  id: UUID;
  handle: string;
  status?: "active" | "left" | "removed" | null;
  joined_at: string;
  left_at?: string | null;
  is_me?: boolean | null;
  display_name: string | null;
  image_url: string | null;
  tagline: string | null;
  verified: boolean;
}

export interface UserChatHandle extends ChatHandleBase {
  kind: "user";
}

export interface AgentChatHandle extends ChatHandleBase {
  kind: "agent";
}

export type ChatHandle = UserChatHandle | AgentChatHandle;

export interface Reaction {
  is_me: boolean;
  handle: ChatHandle;
  type: ReactionType;
  custom_emoji?: string | null;
}

export interface TextPart {
  type: "text";
  value: string;
  mention?: string | null;
  mention_range?: [number, number] | null;
}

export interface MediaPart {
  type: "media";
  url?: string;
  attachment_id?: UUID;
}

export interface LinkPart {
  type: "link";
  value: string;
}

export type MessagePart = TextPart | MediaPart | LinkPart;

export interface TextPartResponse extends TextPart {
  reactions: Reaction[] | null;
}

export interface MediaPartResponse {
  type: "media";
  id: UUID;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
  reactions: Reaction[] | null;
}

export interface LinkPartResponse extends LinkPart {
  reactions: Reaction[] | null;
}

export interface SystemEventParty {
  id: UUID;
  handle: string;
  kind: "user" | "agent";
}

export type TypingContact = SystemEventParty;

export interface TypingIndicatorWebhookData {
  chat_id: UUID;
  contact: TypingContact;
}

export type SystemEventType =
  | "chat_created"
  | "participant_added"
  | "participant_removed"
  | "group_name_updated"
  | "group_icon_updated"
  | "contact_card_shared";

export interface SystemEvent {
  type: SystemEventType;
  actor: SystemEventParty;
  subject: SystemEventParty | null;
  value: string | null;
  icon_attachment_id: UUID | null;
  contact_card: ContactCardItem | null;
}

export interface SystemPartResponse {
  type: "system";
  value: string;
  reactions: null;
}

export type MessagePartResponse =
  | TextPartResponse
  | MediaPartResponse
  | LinkPartResponse
  | SystemPartResponse;

export interface ReplyTo {
  message_id: UUID;
  part_index?: number;
}

export interface MessageContent {
  parts: MessagePart[];
  reply_to?: ReplyTo;
  idempotency_key?: string;
}

export interface SentMessage {
  id: UUID;
  parts: MessagePartResponse[];
  created_at: string;
  sent_at: string | null;
  delivered_at?: string | null;
  delivery_status: DeliveryStatus;
  from_handle?: ChatHandle | null;
  reply_to?: ReplyTo | null;
  is_system_message: boolean;
  system_event?: SystemEvent | null;
}

export interface Message {
  id: UUID;
  chat_id: UUID;
  from?: string | null;
  from_handle?: ChatHandle | null;
  parts?: MessagePartResponse[] | null;
  reply_to?: ReplyTo | null;
  is_system_message: boolean;
  system_event?: SystemEvent | null;
  is_from_me: boolean;
  delivery_status: DeliveryStatus;
  created_at: string;
  updated_at: string;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  deliveries?: MessageDelivery[];
}

export interface MessageDelivery {
  contact: ChatHandle;
  delivered_at: string | null;
  read_at: string | null;
}

export interface Chat {
  id: UUID;
  display_name: string | null;
  group_chat_icon?: string | null;
  handles: ChatHandle[];
  is_group: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatCreateParams {
  from: string;
  to: string[];
  message: MessageContent;
}

export interface ChatCreateResponse {
  chat: Pick<
    Chat,
    "id" | "display_name" | "is_group" | "handles"
  > & { message: SentMessage };
}

export interface ChatUpdateParams {
  display_name?: string;
  group_chat_icon?: UUID | null;
}

export interface AcceptedResponse {
  status?: string;
  message?: string;
  trace_id?: string;
}

export interface ChatUpdateResponse {
  status?: string;
  chat_id?: UUID;
}

export interface ChatListChatsParams {
  cursor?: string;
  limit?: number;
}

export interface ParticipantAddParams {
  handle: string;
}

export type ParticipantRemoveParams = ParticipantAddParams;

export interface MessageSendParams {
  message: MessageContent;
}

export interface MessageSendResponse {
  chat_id: UUID;
  message: SentMessage;
}

export interface MessageCreateParams {
  to: string[];
  message: MessageContent;
  "Idempotency-Key"?: string;
}

export interface MessageCreateResponse {
  from: string;
  chat_id: UUID;
  created_new_chat: boolean;
  is_group: boolean;
  handles: ChatHandle[];
  message: SentMessage;
}

export interface MessageListParams {
  cursor?: string;
  limit?: number;
}

export interface MessageThreadParams extends MessageListParams {
  order?: "asc" | "desc";
}

export interface MessageAddReactionParams {
  operation: "add" | "remove";
  type: ReactionType;
  custom_emoji?: string;
  part_index?: number;
}

export type MessageAddReactionResponse = AcceptedResponse;

export type ChatSendVoicememoParams =
  | { attachment_id: UUID; voice_memo_url?: never }
  | { voice_memo_url: string; attachment_id?: never };

export interface VoiceMemoAttachment {
  id: UUID;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  duration_ms?: number | null;
}

export interface ChatSendVoicememoResponse {
  voice_memo: {
    id: UUID;
    from: string;
    to: string[];
    status: string;
    voice_memo: VoiceMemoAttachment;
    created_at: string;
    chat: {
      id: UUID;
      handles: ChatHandle[];
      is_group: boolean;
    };
  };
}

export type SupportedContentType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/heic"
  | "image/heif"
  | "image/tiff"
  | "image/bmp"
  | "image/webp"
  | "image/x-icon"
  | "video/mp4"
  | "video/quicktime"
  | "video/mpeg"
  | "video/mpeg2"
  | "video/x-m4v"
  | "video/x-msvideo"
  | "video/3gpp"
  | "audio/mpeg"
  | "audio/mp3"
  | "audio/x-m4a"
  | "audio/mp4"
  | "audio/x-caf"
  | "audio/x-wav"
  | "audio/x-aiff"
  | "audio/aiff"
  | "audio/aac"
  | "audio/midi"
  | "audio/amr"
  | "application/pdf"
  | "application/vnd.apple.pkpass"
  | "text/plain"
  | "text/markdown"
  | "text/vcard"
  | "text/rtf"
  | "text/csv"
  | "text/html"
  | "text/calendar"
  | "application/msword"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.ms-excel"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.ms-powerpoint"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/x-iwork-pages-sffpages"
  | "application/x-iwork-numbers-sffnumbers"
  | "application/x-iwork-keynote-sffkey"
  | "application/epub+zip"
  | "text/xml"
  | "application/json"
  | "application/zip"
  | "application/x-gzip";

export interface AttachmentCreateParams {
  filename: string;
  content_type: SupportedContentType;
  size_bytes: number;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface AttachmentCreateResponse {
  attachment_id: UUID;
  upload_url: string;
  download_url: string;
  http_method: "PUT";
  expires_at: string;
  required_headers: Record<string, string>;
}

export interface Attachment {
  id: UUID;
  filename: string;
  content_type: SupportedContentType;
  size_bytes: number;
  status: "pending" | "complete" | "failed";
  download_url?: string;
  created_at: string;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
}

export type WebhookEventType = (typeof RELAY_WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEventListResponse {
  events: WebhookEventType[];
  doc_url: string;
}

export interface WebhookSubscription {
  id: UUID;
  target_url: string;
  subscribed_events: WebhookEventType[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WebhookSubscriptionCreateParams {
  target_url: string;
  subscribed_events: WebhookEventType[];
}

export interface WebhookSubscriptionCreateResponse
  extends WebhookSubscription {
  signing_secret: string;
}

export interface WebhookSubscriptionUpdateParams {
  target_url?: string;
  subscribed_events?: WebhookEventType[];
  is_active?: boolean;
}

export interface WebhookSubscriptionListResponse {
  subscriptions: WebhookSubscription[];
}

export interface ContactCardItem {
  handle: string;
  first_name: string;
  last_name: string | null;
  image_url: string | null;
  is_active: boolean;
  kind: "user" | "agent";
}

export interface ContactCardCreateParams {
  handle: string;
  first_name: string;
  last_name?: string;
  image_url?: string;
}

export interface ContactCardRetrieveParams {
  handle?: string;
}

export interface ContactCardRetrieveResponse {
  contact_cards: ContactCardItem[];
}

export interface ContactCardUpdateParams {
  handle: string;
  first_name?: string;
  last_name?: string | null;
  image_url?: string | null;
}

export interface ContactRequestCreateParams {
  handle: string;
}

export interface ContactRequestCreateResponse {
  state: "pending";
}

export interface BlockedHandle {
  handle: string;
  reason: string | null;
  blocked_at: string;
}

export interface BlockedHandleListResponse {
  blocked_handles: BlockedHandle[];
}

export interface BlockHandleParams {
  handle: string;
  reason?: string;
}

export interface BlockHandleResponse {
  blocked_handle: BlockedHandle;
}

export interface UnblockHandleParams {
  handle: string;
}

export interface WebSocketReadyFrame {
  type: "ready";
  connection_id: UUID;
  acked_through: string;
  full_sync_required: boolean;
  full_sync_through: string | null;
  heartbeat_interval_ms: number;
  max_in_flight: number;
}

export interface WebSocketEventFrame<
  TEvent extends RelayWebhookEvent = RelayWebhookEvent,
> {
  type: "event";
  sequence: string;
  event: TEvent;
}

export interface WebSocketAckFrame {
  type: "ack";
  through_sequence: string;
}

export interface WebSocketFullSyncFrame {
  type: "full_sync";
  through_sequence: string;
  reason: "checkpoint_outside_retention";
}

export interface WebSocketFullSyncCompleteFrame {
  type: "full_sync_complete";
  through_sequence: string;
}

export interface WebSocketPingFrame {
  type: "ping";
  sent_at: string;
}

export interface WebSocketPongFrame {
  type: "pong";
}

export interface WebSocketErrorFrame {
  type: "error";
  code: WebSocketErrorCode;
  message: string;
  fatal: boolean;
  retryable: boolean;
}

export type WebSocketErrorCode =
  | "invalid_frame"
  | "ack_out_of_range"
  | "stale_connection"
  | "ack_failed"
  | "delivery_failed"
  | "full_sync_required"
  | "full_sync_mismatch";

export interface WebSocketDisconnectFrame {
  type: "disconnect";
  reason:
    | "revoked"
    | "heartbeat_timeout"
    | "restart"
    | "webhook_configured";
}

export interface MessageWebhookData {
  chat: {
    id: UUID;
    is_group?: boolean | null;
    owner_handle?: ChatHandle | null;
  };
  id: UUID;
  idempotency_key?: string | null;
  direction: "inbound" | "outbound";
  sender_handle: ChatHandle;
  parts: MessagePartResponse[];
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  reply_to?: ReplyTo | null;
}

export interface ContactEventContact {
  id: UUID;
  handle: string;
  display_name: string;
}

export interface ContactAddedEvent {
  contact: ContactEventContact;
  chat_id: UUID;
}

export interface ContactRemovedEvent {
  contact: ContactEventContact;
}

export interface RelayWebhookEnvelope<
  T = Record<string, unknown>,
  TEventType extends WebhookEventType = WebhookEventType,
> {
  api_version: "v1";
  webhook_version: "2026-08-30";
  event_type: TEventType;
  event_id: UUID;
  created_at: string;
  trace_id: string;
  agent_id: UUID;
  data: T;
}

export type ContactAddedWebhook = RelayWebhookEnvelope<
  ContactAddedEvent,
  "contact.added"
>;

export type ContactRemovedWebhook = RelayWebhookEnvelope<
  ContactRemovedEvent,
  "contact.removed"
>;

export type ContactAddedWebhookData = ContactAddedEvent;
export type ContactRemovedWebhookData = ContactRemovedEvent;
export type ContactAddedWebhookEvent = ContactAddedWebhook;
export type ContactRemovedWebhookEvent = ContactRemovedWebhook;

type MessageWebhookEventType =
  | "message.sent"
  | "message.received"
  | "message.read"
  | "message.delivered";

type TypingIndicatorWebhookEventType =
  | "chat.typing_indicator.started"
  | "chat.typing_indicator.stopped";

type OtherWebhookEventType = Exclude<
  WebhookEventType,
  | MessageWebhookEventType
  | TypingIndicatorWebhookEventType
  | "contact.added"
  | "contact.removed"
>;

export type RelayWebhookEvent =
  | RelayWebhookEnvelope<MessageWebhookData, MessageWebhookEventType>
  | RelayWebhookEnvelope<
    TypingIndicatorWebhookData,
    TypingIndicatorWebhookEventType
  >
  | ContactAddedWebhookEvent
  | ContactRemovedWebhookEvent
  | RelayWebhookEnvelope<Record<string, unknown>, OtherWebhookEventType>;
