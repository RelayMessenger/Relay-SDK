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
  about: string | null;
  verified: boolean;
  is_removable?: boolean;
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
  /**
   * Send the Message with no banner and no sound on the recipient's device.
   * The Message still arrives, still counts as unread, and still moves the
   * Chat to the top of the list. Defaults to `false`.
   */
  silent?: boolean;
}

/**
 * The Message a send returns. A send never produces a system Message, so its
 * parts are only text, media or link, and it carries no `system_event`.
 * `is_system_message` is on the wire and is always `false` here; the contract's
 * `SentMessage` does not declare it yet.
 * Read paths (`chats.messages.list`, `messages.listMessagesThread`) return
 * `Message`, which does carry system events and system parts.
 */
export interface SentMessage {
  id: UUID;
  parts: Array<TextPartResponse | MediaPartResponse | LinkPartResponse>;
  created_at: string;
  sent_at: string | null;
  delivered_at?: string | null;
  delivery_status: DeliveryStatus;
  from_handle?: ChatHandle | null;
  reply_to?: ReplyTo | null;
  /**
   * Whether the sender sent this Message silently, so the recipient's device
   * showed no banner and played no sound.
   */
  silent?: boolean;
  is_system_message: false;
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
  /** When the Message was last edited, or null if it was never edited. */
  edited_at?: string | null;
  /**
   * When the sender unsent the Message, or null. An unsent Message keeps its
   * place in the transcript and carries no parts.
   */
  unsent_at?: string | null;
  /**
   * Whether the sender sent this Message silently, so the recipient's device
   * showed no banner and played no sound.
   */
  silent?: boolean;
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
  /**
   * The caller's side of a message request on this Chat: `pending` while a
   * sender with no Contact edge to the caller wrote to them and they have not
   * answered, `accepted` or `deleted` once they have. Absent when the caller
   * was never asked; an agent never is.
   */
  request_state?: ChatRequestState;
  created_at: string;
  updated_at: string;
}

export type ChatRequestState = "pending" | "accepted" | "deleted";

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
  /**
   * Group photo for the chat, in either of two forms. A completed image
   * Attachment ID uses an image you already uploaded. Any publicly reachable
   * HTTPS image address also works: Relay downloads it and serves a permanent
   * copy of its own, so the address you supply does not have to stay up. Send
   * null to clear the photo.
   */
  group_chat_icon?: string | null;
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
  /** Hide history before the new membership. Omission uses the server default: true. */
  hide_history?: boolean;
}

export interface ParticipantRemoveParams {
  handle: string;
}

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
  /**
   * `asc` (default) lists oldest first; `desc` opens on the newest Messages
   * and pages toward older ones. A cursor is only valid with the order it
   * was returned for.
   */
  order?: "asc" | "desc";
}

export type MessageThreadParams = MessageListParams;

/**
 * `PATCH /v1/messages/{messageId}`. Only text parts can be edited, up to five
 * times, and only within 15 minutes of the original send.
 */
export interface MessageEditParams {
  /** Index of the Message part to edit. Defaults to 0. */
  part_index?: number;
  text: string;
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
  /** Pixel width when known. Width and height are supplied together. */
  width?: number | null;
  /** Pixel height when known. Width and height are supplied together. */
  height?: number | null;
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

/**
 * Relay accepts any RFC 2045 `type/subtype` media type for an Attachment and
 * stores and returns the original bytes unchanged. The literals below are the
 * types Relay names in the v1 contract; they stay for editor completion, and
 * `(string & {})` keeps any other valid media type assignable. Relay falls
 * back to `application/octet-stream`. Only pictures and group icons must be
 * images.
 */
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
  | "application/x-gzip"
  | (string & {});

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
  /** Caller-owned completed image upload; mutually exclusive with image_url. */
  attachment_id?: UUID;
  /** Existing redraw metadata; requires image_url or attachment_id. */
  image_recipe?: AgentImageRecipe;
}

export interface ContactCardRetrieveParams {
  handle?: string;
}

export interface ContactCardRetrieveResponse {
  contact_cards: ContactCardItem[];
}

export interface ContactCardUpdateParams {
  /** Server contract 3097dda: trimmed about text, 1 to 60 characters. */
  about?: string;
  handle: string;
  first_name?: string;
  last_name?: string | null;
  image_url?: string | null;
  /** Caller-owned completed image upload; mutually exclusive with image_url, including null. */
  attachment_id?: UUID;
  /** Existing redraw metadata; requires an image URL or completed upload. */
  image_recipe?: AgentImageRecipe;
}

export interface BlockedHandle {
  handle: string;
  /** Optional note recorded when the handle was blocked. */
  reason?: string | null;
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

/** The Chat object every Message event carries. */
export interface MessageEventChat {
  id: UUID;
  is_group?: boolean | null;
  owner_handle?: ChatHandle | null;
}

export interface MessageWebhookData {
  chat: MessageEventChat;
  id: UUID;
  idempotency_key?: string | null;
  direction: "inbound" | "outbound";
  sender_handle: ChatHandle;
  parts: MessagePartResponse[];
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  /**
   * Whether the sender sent this Message silently, so the recipient's device
   * showed no banner and played no sound.
   */
  silent?: boolean;
  reply_to?: ReplyTo | null;
}

/** The part an edit replaced, and its zero-based index in the Message. */
export interface MessageEditedPart {
  index: number;
  text: string;
}

/**
 * `message.edited`. `direction` is relative to the receiving Agent:
 * `outbound` if the Agent sent the original Message, `inbound` otherwise.
 */
export interface MessageEditedEvent {
  chat: MessageEventChat;
  direction: "inbound" | "outbound";
  edited_at: string;
  id: UUID;
  part: MessageEditedPart;
  sender_handle: ChatHandle | null;
}

/**
 * `message.unsent`. The `message.edited` shape without `part` -- an unsend
 * takes the whole Message, not one part of it -- carrying `unsent_at` where
 * the edit carries `edited_at`. Deriving it here keeps the two shapes from
 * drifting apart.
 */
export interface MessageUnsentEvent
  extends Omit<MessageEditedEvent, "edited_at" | "part"> {
  unsent_at: string;
}

/**
 * `message.failed`. Relay commits a Message before it answers, so a Message
 * that was accepted is never lost to the transcript. This event says the
 * Message could not be handed to a recipient Agent.
 */
export interface MessageFailedEvent {
  chat_id?: UUID;
  message_id?: UUID;
  code: number;
  reason?: string;
  /**
   * Opaque diagnostic identifying the specific failure class within `code`.
   * Log it and include it in support requests, but do not branch on it.
   */
  detail_code?: number | null;
  failed_at: string;
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

/** A person answered your message request. */
export interface ChatRequestUpdatedEvent {
  /** The Chat the person answered on. */
  chat_id: UUID;
  /**
   * `accepted`: the person added you; your Messages land in their inbox from
   * now on. `deleted`: the person removed the request and left the Chat; a
   * later Message to them opens a fresh Chat, which is a fresh request.
   */
  state: "accepted" | "deleted";
  /** When the person answered. */
  updated_at: string;
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

export type ChatRequestUpdatedWebhook = RelayWebhookEnvelope<
  ChatRequestUpdatedEvent,
  "chat.request.updated"
>;

export type MessageEditedWebhook = RelayWebhookEnvelope<
  MessageEditedEvent,
  "message.edited"
>;

export type MessageUnsentWebhook = RelayWebhookEnvelope<
  MessageUnsentEvent,
  "message.unsent"
>;

export type MessageFailedWebhook = RelayWebhookEnvelope<
  MessageFailedEvent,
  "message.failed"
>;

export type ContactAddedWebhookData = ContactAddedEvent;
export type ContactRemovedWebhookData = ContactRemovedEvent;
export type ContactAddedWebhookEvent = ContactAddedWebhook;
export type ContactRemovedWebhookEvent = ContactRemovedWebhook;
export type ChatRequestUpdatedWebhookData = ChatRequestUpdatedEvent;
export type ChatRequestUpdatedWebhookEvent = ChatRequestUpdatedWebhook;

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
  | "chat.request.updated"
  | "message.edited"
  | "message.unsent"
  | "message.failed"
>;

export type RelayWebhookEvent =
  | RelayWebhookEnvelope<MessageWebhookData, MessageWebhookEventType>
  | RelayWebhookEnvelope<
    TypingIndicatorWebhookData,
    TypingIndicatorWebhookEventType
  >
  | MessageEditedWebhook
  | MessageUnsentWebhook
  | MessageFailedWebhook
  | ContactAddedWebhookEvent
  | ContactRemovedWebhookEvent
  | ChatRequestUpdatedWebhookEvent
  | RelayWebhookEnvelope<Record<string, unknown>, OtherWebhookEventType>;

/** Existing Relay avatar gradient pairs, ordered top then base. */
export type AgentImageGradient =
  | readonly ["EC8A3C", "C85F1C"]
  | readonly ["E0567A", "AD2A52"]
  | readonly ["D05FC6", "93217E"]
  | readonly ["8F6CF2", "5F38CF"]
  | readonly ["5B9BFA", "0B52C0"]
  | readonly ["2596A6", "116A79"]
  | readonly ["2FA46A", "137347"];

export interface AgentImageBackground {
  linearGradient: { colors: AgentImageGradient };
}
export interface AgentMonogramImageRecipe {
  recipe: { monogram: { initials: string }; emoji?: never; image?: never };
  background: AgentImageBackground;
}
export interface AgentEmojiImageRecipe {
  recipe: { emoji: { emoji: string }; monogram?: never; image?: never };
  background: AgentImageBackground;
}
export interface AgentPhotoImageRecipe {
  recipe: { image: Record<string, never>; monogram?: never; emoji?: never };
  background?: never;
}
export type AgentImageRecipe = AgentMonogramImageRecipe | AgentEmojiImageRecipe | AgentPhotoImageRecipe;

/** POST /v1/agents optional identity fields; omissions retain server defaults. */
export interface AgentCreateProfileParams {
  /** Server contract 3097dda: trimmed about text, 1 to 60 characters. */
  about?: string;
  token_name?: string;
  /** Full lowercase developer handle, including .dev. */
  handle?: string;
  /** Display name; the server trims surrounding whitespace. */
  first_name?: string;
}
/** A recipe is redraw metadata, not a renderer: supply its HTTPS snapshot URL. */
export type AgentCreateParams = AgentCreateProfileParams & (
  | { image_url?: string; image_recipe?: never }
  | { image_url: string; image_recipe: AgentImageRecipe }
);

export interface AgentCreateResponse {
  agent: ContactCardItem;
  secret: string;
  share_url: string;
}
