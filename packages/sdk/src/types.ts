import type { RELAY_WEBHOOK_EVENT_TYPES } from "./operations.js";

export type UUID = string;

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
  headers?: HeadersInit;
}

export interface CallContact {
  id: UUID;
  handle: string;
  kind: "user" | "agent";
}

export type CallTerminalStatus =
  | "completed"
  | "no-answer"
  | "canceled"
  | "busy"
  | "failed";

export interface Call {
  id: UUID;
  chat_id: UUID;
  from: CallContact;
  to: [CallContact];
  /** `ringing` and `in-progress` are live. Terminal states set `ended_at`. */
  status: "ringing" | "in-progress" | CallTerminalStatus;
  revision: number;
  created_at: string;
  ringing_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface CallCreateParams {
  to: [string];
}

export interface CallCreateOptions extends RequestOptions {
  /** Reuse this key and request after an uncertain response. */
  idempotencyKey: string;
}

export interface CallListParams {
  cursor?: string;
  limit?: number;
}

export interface CallListResponse {
  calls: Call[];
  next_cursor: string | null;
}

export interface CallResponse {
  call: Call;
}

/** A participant's published local track, named on the SFU. */
export type CallRoomTrackName = "audio" | "video";

export interface CallRoomParticipant {
  contact_id: UUID;
  kind: "user" | "agent";
  attached: boolean;
  track: "audio" | null;
  muted: boolean;
  connected: boolean;
  /** Camera sending, from this participant's `userUpdate`. */
  video?: boolean;
  /** Tracks this participant has published: `[]` before its first offer, then `["audio"]` or `["audio", "video"]`. */
  tracks?: CallRoomTrackName[];
  /**
   * The other participant's tracks this participant is receiving now: its
   * pull answer is applied and it sent `connected` for it. Reset on restart.
   */
  receiving?: CallRoomTrackName[];
}

export interface CallRoomJoinFrame {
  type: "join";
}

export interface CallRoomPublishOfferFrame {
  type: "offer";
  session_description: { type: "offer"; sdp: string };
  /** One or two tracks, `audio` first, no duplicate names. */
  tracks:
    | [{ mid: string; name: "audio" }]
    | [{ mid: string; name: "audio" }, { mid: string; name: "video" }]
    | [{ mid: string; name: "video" }];
  /** The previous session is dead: publish on a brand-new session from a new peer connection. */
  restart?: boolean;
}

export interface CallRoomAnswerFrame {
  type: "answer";
  session_description: { type: "answer"; sdp: string };
}

export interface CallRoomConnectedFrame {
  type: "connected";
}

export interface CallRoomUserUpdateFrame {
  type: "userUpdate";
  muted: boolean;
  /** Camera sending. Omitted keeps the last value. */
  video?: boolean;
}

export interface CallRoomEndFrame {
  type: "end";
}

export interface CallRoomHeartbeatFrame {
  type: "heartbeat";
}

export type CallRoomClientFrame =
  | CallRoomJoinFrame
  | CallRoomPublishOfferFrame
  | CallRoomAnswerFrame
  | CallRoomConnectedFrame
  | CallRoomUserUpdateFrame
  | CallRoomEndFrame
  | CallRoomHeartbeatFrame;

export interface CallRoomStateFrame {
  type: "roomState";
  call: Call;
  participants: [CallRoomParticipant, CallRoomParticipant];
}

export interface CallRoomServerAnswerFrame {
  type: "answer";
  session_description: { type: "answer"; sdp: string };
}

export interface CallRoomSubscriptionOfferFrame {
  type: "offer";
  session_description: { type: "offer"; sdp: string };
  /** The other participant's track this renegotiation pulls. */
  track: CallRoomTrackName;
}

export interface CallRoomEndedFrame {
  type: "ended";
  reason: CallTerminalStatus;
}

export type CallRoomErrorCode =
  | "invalid_frame"
  | "not_allowed"
  | "media_unavailable";

export interface CallRoomErrorFrame {
  type: "error";
  code: CallRoomErrorCode;
  message: string;
}

/** Standard `RTCIceServer`: STUN or TURN URLs, with credentials on TURN servers. */
export interface CallRoomIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * STUN and TURN servers for this participant's peer connection, sent after
 * every accepted `join` and before the first `roomState` (Orange Meets shape:
 * Cloudflare TURN credentials minted by the server).
 */
export interface CallRoomIceServersFrame {
  type: "iceServers";
  ice_servers: CallRoomIceServer[];
}

export type CallRoomServerFrame =
  | CallRoomIceServersFrame
  | CallRoomStateFrame
  | CallRoomServerAnswerFrame
  | CallRoomSubscriptionOfferFrame
  | CallRoomEndedFrame
  | CallRoomErrorFrame;

export type CallWebhookEvent = RelayWebhookEnvelope<
  CallResponse,
  "call.created" | "call.updated" | "call.ended"
>;

/** Subscription mode only. One coupon or one promotion code from your connected Stripe account, never both. */
export interface PaymentDiscount {
  /** The id of a coupon on your connected Stripe account. */
  coupon?: string;
  /** The id of a promotion code (`promo_...`), not the code a customer types. */
  promotion_code?: string;
  /** Your own name for the discount, stored and returned with the request. */
  label?: string;
}

/**
 * `POST /v1/payment_requests`. Payment mode needs `amount` and `currency`;
 * subscription mode needs `price_id` and takes the currency from the price.
 */
export interface PaymentRequestCreateParams {
  /** Payment mode: what to charge, in the currency's minor units. */
  amount?: number;
  /** Payment mode: a 3-letter ISO 4217 code, returned lowercase. */
  currency?: string;
  /** The card's title line and the checkout's product name. Trimmed; 1 to 32 characters. */
  description: string;
  category: PaymentCategory;
  /** Up to 49 keys of your own; keys starting with `relay_` are reserved. */
  metadata?: Record<string, string>;
  /** Defaults to `payment`. */
  mode?: PaymentMode;
  /** Subscription mode: an active recurring Price on your connected Stripe account. */
  price_id?: string;
  /** Subscription mode: units of the price. Defaults to 1. */
  quantity?: number;
  /** An existing Customer on your connected Stripe account (`cus_...`). */
  customer_id?: string;
  discount?: PaymentDiscount;
  /** Optional HTTPS product picture; Relay copies it into its own image store. */
  image_url?: string;
}

export interface PaymentRequestCreateOptions extends RequestOptions {
  /** Reusing a key with the same body returns the first request (200); with a different body, 409. */
  idempotencyKey?: string;
}

/** The ids of the Stripe objects on your connected account. */
export interface PaymentRequestStripe {
  /** The one PaymentIntent the person pays (`pi_...`). */
  payment_intent_id: string;
  customer_id?: string;
  /** Subscription mode (`sub_...`). */
  subscription_id?: string;
}

export interface PaymentRequest {
  id: UUID;
  object: "payment_request";
  status: PaymentStatus;
  mode: PaymentMode;
  /** What the person is charged at checkout, in minor units. */
  amount: number;
  /** Relay's 5% fee in minor units. */
  application_fee_amount: number;
  currency: string;
  description: string;
  category: PaymentCategory;
  /** Relay's pay page for this request. Send it back unchanged in a `payment` part. */
  checkout_url: string;
  /** 23 hours after creation; the request then moves to `expired`. */
  expires_at: string;
  metadata: Record<string, string>;
  image_url?: string;
  price_id?: string;
  quantity?: number;
  interval?: PaymentRecurring["interval"];
  interval_count?: number;
  discount?: PaymentDiscount;
  stripe: PaymentRequestStripe;
  /** Absent until the request succeeds. */
  paid_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentRequestListParams {
  cursor?: string;
  /** 1 to 100; defaults to 20. */
  limit?: number;
  status?: PaymentStatus;
}

export interface PaymentRequestListResponse {
  payment_requests: PaymentRequest[];
  next_cursor: string | null;
}

/** `POST /v1/chats/{chatId}/location/request` answers with this once the request is in the chat. */
export interface LocationRequestResponse {
  success: true;
  message: "Location request sent";
}

/** One person sharing their location with your agent, as a GeoJSON Feature (RFC 7946). */
export interface LocationFeature {
  type: "Feature";
  geometry: {
    type: "Point";
    /** `[longitude, latitude]`, longitude first. */
    coordinates: [number, number];
  };
  properties: {
    /** Handle of the person sharing. */
    handle: string;
    /** When this position arrived. */
    updated_at: string;
  };
}

/**
 * `GET /v1/chats/{chatId}/location`: one Feature per person sharing with your
 * agent in the chat; `features` is empty when nobody is sharing.
 */
export interface GetChatLocationResponse {
  success: true;
  data: {
    type: "FeatureCollection";
    features: LocationFeature[];
  };
}

/** `location.sharing.started`: a person started sharing their location with your agent. */
export interface LocationSharingStartedEvent {
  /** Handle of the person who started sharing. */
  shared_by: string;
  /** Handle of your agent. */
  shared_with: string;
  chat_id: UUID;
  began_at: string;
  /** When the share ends by itself; null when it has no end. */
  ends_at: string | null;
}

/** `location.sharing.stopped`: the person stopped sharing, or the share reached its end. */
export interface LocationSharingStoppedEvent {
  /** Handle of the person who stopped sharing. */
  shared_by: string;
  /** Handle of your agent. */
  shared_with: string;
  chat_id: UUID;
  began_at: string;
  /** When the share ended. Equals the share's `ends_at` when it ran out. */
  ended_at: string;
}

export type LocationSharingStartedWebhookEvent = RelayWebhookEnvelope<
  LocationSharingStartedEvent,
  "location.sharing.started"
>;

export type LocationSharingStoppedWebhookEvent = RelayWebhookEnvelope<
  LocationSharingStoppedEvent,
  "location.sharing.stopped"
>;

export type PaymentWebhookEvent = RelayWebhookEnvelope<
  PaymentRequest,
  "payment.succeeded" | "payment.canceled" | "payment.expired"
>;

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

export interface ChatActivity {
  id: UUID;
  text: string;
  emoji: string | null;
  updated_at: string;
  expires_at: string;
}

export interface ChatActivityResponse {
  chat_id: UUID;
  agent_id: UUID;
  version: string;
  activity: ChatActivity | null;
}

export interface ChatSetActivityParams {
  /** 1–21 visible characters, at most 1024 UTF-8 bytes. */
  text: string;
  /** One Unicode emoji, or null. */
  emoji?: string | null;
  /** Omit to start/replace; supply the current ID to refresh/update. */
  activity_id?: UUID;
}

export interface ChatClearActivityParams {
  /** Clear only this task. A stale or missing activity is a successful no-op. */
  activity_id?: UUID;
}

interface ChatHandleBase {
  id: UUID;
  handle: string;
  status?: "active" | "left" | "removed" | null;
  joined_at: string;
  left_at?: string | null;
  is_me?: boolean | null;
  display_name: string | null;
  image_url: string | null;
  subtitle: string | null;
  verified: boolean;
  /** True when the caller holds this Handle as a Contact. */
  is_contact: boolean;
  activity_version?: string;
  activity?: ChatActivity | null;
}

export interface UserChatHandle extends ChatHandleBase {
  kind: "user";
}

/** Who owns an agent: its organization, or the person who owns it. */
export type HandleOwner =
  | {
    kind: "organization";
    /** The organization's name in Relay Console. Null until it has one. */
    name: string | null;
    /** Whether Relay has verified the organization. */
    verified: boolean;
  }
  | {
    kind: "user";
    /** The owning person's Relay Handle. Null when the person has no Relay account. */
    handle: string | null;
    /** The owning person's display name. Null when the person has no Relay account. */
    display_name: string | null;
  };

export interface AgentChatHandle extends ChatHandleBase {
  kind: "agent";
  /** Who owns this agent. Null for an agent no organization or person owns. */
  owner?: HandleOwner | null;
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

/**
 * One button in a `buttons`. A tap on a plain button sends its `label` back
 * as the person's next message: one `text` part whose value is the label,
 * with `reply_to` naming the `buttons` part. A `url` button opens the page
 * in the app and sends nothing.
 */
export interface ButtonItem {
  /** Link button: the tap opens this HTTPS URL instead of sending the label. */
  url?: string;
  /** The button's visible text, 1 to 80 characters, and what a tap sends. */
  label: string;
}

/**
 * Agent-only: a vertical stack of 1 to 5 text-only buttons under the message.
 * At most one per message. The only reply it accepts is a tap; reactions may
 * not target it.
 */
export interface ButtonsPart {
  type: "buttons";
  items: ButtonItem[];
}

/** Stable machine value and independently editable visible label. */
export interface SelectionOption {
  /** Unique case-sensitive ASCII token, 1–100 characters. Never derived from label. */
  value: string;
  /** Trimmed visible label, 1–80 characters. */
  label: string;
}

/** Agent-only, 1–25 options; requires nonblank text and cannot mix with buttons. */
export interface SelectionPart {
  type: "selection";
  /** The text is the prompt's title; the person checks any number of options and submits them once, and checking sends nothing. */
  options: SelectionOption[];
}

export interface SelectionPartResponse extends SelectionPart {
  /** Durable response state for this viewer across devices. Existing Chat rules allow at most one human user; only that user can respond, once; reopening an answered selection shows what they chose without letting them change it. */
  readonly has_responded: boolean;
  /** The values the authenticated viewer chose, in source-option order, identical on every one of that user's devices; null until the viewer answers, when the answer Message no longer exists, and always for an agent viewer. */
  readonly selected_values: string[] | null;
  reactions: null;
}

/**
 * User-only metadata after canonical text (literal '• ' + each source
 * label, joined with '\n'), with explicit reply_to. Exact legacy comma-joined
 * labels are accepted by the server only for compatibility, never parsed for IDs.
 */
export interface SelectionResponsePart {
  type: "selection_response";
  /**
   * Unique known values, nonempty and in source-option order, authoritative with
   * reply_to. New preceding text is literal '• ' + each source label joined with
   * '\n'. The server accepts exact legacy comma-joined labels for compatibility
   * only, never arbitrary label parsing. iOS may draw a checkmark in place of
   * each bullet and repeat the prompt's title, as presentation only; portable
   * text remains bullets.
   */
  selected_values: string[];
}

/** Metadata only: contributes no visible fallback text. */
export interface SelectionResponsePartResponse extends SelectionResponsePart {}

/** What is being paid for (PayPal Orders v2 `items[].category`); App Store rules decide where each is payable. */
export type PaymentCategory = "physical_goods" | "digital_goods" | "donation";

/** A payment request's lifecycle. It leaves `requested` exactly once, only on Stripe's word or your cancel. */
export type PaymentStatus = "requested" | "succeeded" | "canceled" | "expired";

/** `payment` collects one charge; `subscription` starts a Stripe subscription from a recurring price. */
export type PaymentMode = "payment" | "subscription";

/** A subscription's renewal cadence, read from its Stripe Price. */
export interface PaymentRecurring {
  interval: "day" | "week" | "month" | "year";
  /** Intervals per renewal (3 with `month` is quarterly). */
  interval_count: number;
}

/**
 * A request to pay, drawn as a card. `checkout_url` is the only field: pass
 * back exactly what `paymentRequests.create` returned. The card's amount and
 * title are read from that request, never from the message. Sent only by the
 * agent that created the request, while it is `requested`; it must be the only
 * part of its message.
 */
export interface PaymentPart {
  type: "payment";
  /** At most 2048 characters. */
  checkout_url: string;
}

/** A payment card as every reader sees it, read from the payment request. `status` changes in place. */
export interface PaymentPartResponse {
  type: "payment";
  payment_request_id: UUID;
  checkout_url: string;
  /** Minor units. For a subscription, what the first period costs. */
  amount: number;
  currency: string;
  /** The card's title line. */
  description: string;
  category: PaymentCategory;
  mode: PaymentMode;
  recurring?: PaymentRecurring;
  /** The request's product picture, when it has one. */
  image_url?: string;
  status: PaymentStatus;
  /** Only a person can react to a payment. */
  reactions: Reaction[] | null;
}

/**
 * The payer's receipt: Relay adds one message from the person who paid, a
 * reply to the `payment` card, when a request succeeds. It arrives as
 * `message.received`. Only Relay writes this part.
 */
export interface PaymentReceiptPartResponse {
  type: "payment_receipt";
  payment_request_id: UUID;
  description: string;
  /** What was paid, in minor units. For a subscription, what the first period cost. */
  amount: number;
  currency: string;
  mode: PaymentMode;
  recurring?: PaymentRecurring;
  reactions: Reaction[] | null;
}

/**
 * An agent's request for the person's location, sent with
 * `chats.location.request`. It cannot be sent as a message part. A client that
 * does not draw it shows the Message's text, "<agent display name> requested
 * your location".
 */
export interface LocationRequestPartResponse {
  type: "location_request";
  reactions: Reaction[] | null;
}

/**
 * A person's location share, the card the person's app draws. It carries the
 * share's state, never its position: read the position with
 * `chats.location.retrieve`. It cannot be sent as a message part. A share whose
 * `ends_at` has passed reads as `ended` with `ended_at` equal to `ends_at`.
 */
export interface LocationPartResponse {
  type: "location";
  state: "live" | "ended";
  began_at: string | null;
  /** When the share ends by itself; null when it has no end. */
  ends_at: string | null;
  ended_at: string | null;
  reactions: Reaction[] | null;
}

/**
 * A place sent once: a person's current location, a dropped pin, or a place an
 * agent names (Relay-Server contract `PlacePart`; WhatsApp Cloud API's location
 * fields). `name` and `address` are 1 to 256 characters after trimming.
 */
export interface PlacePart {
  type: "place";
  /** Latitude in degrees (WGS 84), -90 to 90. */
  latitude: number;
  /** Longitude in degrees (WGS 84), -180 to 180. */
  longitude: number;
  name?: string;
  address?: string;
}

/** A place as its sender sent it; `name` and `address` are absent when left out. */
export interface PlacePartResponse extends PlacePart {
  reactions: Reaction[] | null;
}

/**
 * A2UI v0.9.1 (https://a2ui.org), the messages a card is made of. The shapes
 * are A2UI's own JSON schemas (`specification/v0_9_1/json/*.json` in
 * google/A2UI): `server_to_client.json` for what an agent sends to draw a
 * card, `client_to_server.json` for a tap (`action`) and an `error`. The
 * version enum is A2UI's (`v0.9` or `v0.9.1`); Relay's contract names v0.9.1.
 */
export type A2uiVersion = "v0.9" | "v0.9.1";

/**
 * One component of a surface: `id`, the catalog's `component` name, and that
 * component's own properties, for example
 * `{ id: "title", component: "Text", text: "Lakers win tonight?" }`. The
 * catalog named by `createSurface.catalogId` defines them: Relay refuses a
 * component, property or value that catalog does not define.
 */
export interface A2uiComponent {
  id: string;
  component: string;
  [property: string]: unknown;
}

/** A2UI `createSurface`: starts a surface drawn by the Message that carries it. */
export interface A2uiCreateSurfaceMessage {
  version: A2uiVersion;
  createSurface: {
    surfaceId: string;
    /** A catalog Relay draws; see `A2uiClientCapabilities`. */
    catalogId: string;
    /** Theme values the catalog defines, for example `{ primaryColor: "#FF0000" }`. */
    theme?: Record<string, unknown>;
    /** When true, every tap on the surface carries the surface's data model in `metadata.a2uiClientDataModel`. */
    sendDataModel?: boolean;
  };
}

/** A2UI `updateComponents`: adds or replaces components by `id`. A surface's first update holds the component with the id `root`. */
export interface A2uiUpdateComponentsMessage {
  version: A2uiVersion;
  updateComponents: {
    surfaceId: string;
    components: A2uiComponent[];
  };
}

/**
 * A2UI `updateDataModel`: replaces (or creates) the value at `path`, a JSON
 * Pointer; no `path`, or `/`, is the whole data model. No `value` removes the
 * key at `path`.
 */
export interface A2uiUpdateDataModelMessage {
  version: A2uiVersion;
  updateDataModel: {
    surfaceId: string;
    path?: string;
    value?: unknown;
  };
}

/** A2UI `deleteSurface`: removes the surface for everyone. */
export interface A2uiDeleteSurfaceMessage {
  version: A2uiVersion;
  deleteSurface: {
    surfaceId: string;
  };
}

/** What an agent sends to draw, change or remove a card (A2UI `server_to_client.json`). */
export type A2uiServerToClientMessage =
  | A2uiCreateSurfaceMessage
  | A2uiUpdateComponentsMessage
  | A2uiUpdateDataModelMessage
  | A2uiDeleteSurfaceMessage;

/** The body of an A2UI `action` message: a tap on a Button. */
export interface A2uiAction {
  /** The Button's `action.event.name`. */
  name: string;
  surfaceId: string;
  /** The `id` of the Button that was tapped. */
  sourceComponentId: string;
  /** ISO 8601 time of the tap. */
  timestamp: string;
  /** The Button's `action.event.context`, with every data binding resolved. */
  context: Record<string, unknown>;
}

/** A2UI `action`: a person (or an agent) tapped a Button on a surface. */
export interface A2uiActionMessage {
  version: A2uiVersion;
  action: A2uiAction;
}

/** A2UI's validation error: `path` is a JSON Pointer to the field that failed. */
export interface A2uiValidationError {
  code: "VALIDATION_FAILED";
  surfaceId: string;
  path: string;
  message: string;
}

/** A2UI's generic error: any other `code`. */
export interface A2uiGenericError {
  code: string;
  surfaceId: string;
  message: string;
  [property: string]: unknown;
}

/** A2UI `error`: a renderer (or an agent) reports that it could not use a message. */
export interface A2uiErrorMessage {
  version: A2uiVersion;
  error: A2uiValidationError | A2uiGenericError;
}

/**
 * A2UI's `error` message in its validation format, as Relay writes it for a
 * message it did not apply. `surfaceId` is empty when the message named none;
 * `path` points inside the failing message's body, as in A2UI's own example
 * `/components/0/text`, and is empty when the whole message is at fault.
 */
export interface A2uiValidationErrorMessage {
  version: "v0.9.1";
  error: A2uiValidationError;
}

/** One A2UI message of a send that Relay did not apply, where it sits in the request, and A2UI's `error` message for it. */
export interface A2uiFailure {
  /** The data part's index in `parts`; null when the fault is in `metadata.a2uiClientDataModel`. */
  part_index: number | null;
  /** The message's index in that part's `data`; null when the part itself, or the metadata, is at fault. */
  data_index: number | null;
  a2ui_message: A2uiValidationErrorMessage;
}

/** What a renderer sends back (A2UI `client_to_server.json`). */
export type A2uiClientToServerMessage = A2uiActionMessage | A2uiErrorMessage;

/** Any A2UI v0.9.1 message a data part may carry. */
export type A2uiMessage = A2uiServerToClientMessage | A2uiClientToServerMessage;

/**
 * A data part holding A2UI v0.9.1 messages, in order: Relay's REST shape of
 * A2A's DataPart. A Message may carry any number of data parts beside its
 * other parts. Relay applies each A2UI message on its own, checked against
 * A2UI's schemas and the surface's catalog: the ones that fail come back in
 * the response's `a2ui_errors`, and a send that applies nothing is refused
 * (404, 409 or 422) with `a2ui_errors` in the error body. Only an agent sends
 * `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface`;
 * a send that only changes an earlier card adds no Message and returns that
 * card. An `action` or `error` reaches only its sender and the agent that
 * created the surface it names.
 */
export interface DataPart {
  type: "data";
  media_type: "application/a2ui+json";
  data: A2uiMessage[];
}

/**
 * A data part as a reader receives it: the `action` and `error` messages it
 * carried, as sent, when the reader sent them or created the surface they
 * name; then, for each surface it created, every A2UI message accepted for
 * that surface since, in order. Replay the list to draw the card.
 */
export interface DataPartResponse extends DataPart {
  reactions: Reaction[] | null;
}

/** A2UI's `a2uiClientDataModel` (`client_data_model.json`): each surface's data model, by surface id. */
export interface A2uiClientDataModel {
  version: A2uiVersion;
  surfaces: Record<string, Record<string, unknown>>;
}

/**
 * A2UI's `a2uiClientCapabilities` (`client_capabilities.json`, keyed by the
 * protocol family `v0.9`): the catalogs Relay's app draws, in order of
 * preference. Relay's catalog (`RELAY_A2UI_CATALOG_ID`) is every basic catalog
 * component and function plus `PaymentRequest`.
 */
export interface A2uiClientCapabilities {
  "v0.9": {
    supportedCatalogIds: string[];
    inlineCatalogs?: Array<Record<string, unknown>>;
  };
}

/**
 * A2A Message metadata. A tap on a surface that set `sendDataModel` carries
 * `a2uiClientDataModel`. Each surface's data model reaches only the sender and
 * the agent that created that surface, unchanged.
 */
export interface MessageMetadata {
  a2uiClientDataModel?: A2uiClientDataModel;
}

/** The metadata on every `message.received`: the reader's A2UI catalogs, and the sender's data model for the surfaces this agent created, when it sent one. */
export interface MessageReceivedMetadata extends MessageMetadata {
  a2uiClientCapabilities: A2uiClientCapabilities;
}

export type MessagePart =
  | TextPart
  | MediaPart
  | LinkPart
  | ButtonsPart
  | SelectionPart
  | SelectionResponsePart
  | PaymentPart
  | DataPart
  | PlacePart;

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

export interface ButtonsPartResponse extends ButtonsPart {
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
  | "contact_card_shared"
  | "call";

export interface CallMarker {
  id: UUID;
  status: Call["status"];
  answered_at: string | null;
  ended_at: string | null;
  from: CallContact;
  to: [CallContact];
  duration_seconds: number | null;
}

export interface SystemEvent {
  type: SystemEventType;
  actor: SystemEventParty;
  subject: SystemEventParty | null;
  value: string | null;
  icon_attachment_id: UUID | null;
  contact_card: ContactCardItem | null;
  call: CallMarker | null;
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
  | ButtonsPartResponse
  | SelectionPartResponse
  | SelectionResponsePartResponse
  | PaymentPartResponse
  | PaymentReceiptPartResponse
  | DataPartResponse
  | LocationRequestPartResponse
  | LocationPartResponse
  | PlacePartResponse
  | SystemPartResponse;

/** Ordinary replies target text, media, or link, never system. A buttons part
 * accepts only a tap: one text part equal to one of its plain labels. A selection
 * requires explicit part_index and exactly text then selection_response metadata. */
export interface ReplyTo {
  message_id: UUID;
  part_index?: number;
}

export interface MessageContent {
  parts: MessagePart[];
  reply_to?: ReplyTo;
  /**
   * A2A Message metadata. A tap (an A2UI `action`) on a surface that set
   * `sendDataModel` must carry `a2uiClientDataModel`.
   */
  metadata?: MessageMetadata;
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
 * parts exclude system parts, and it carries no `system_event`.
 * `is_system_message` is on the wire and is always `false` here; the contract's
 * `SentMessage` does not declare it yet.
 * Read paths (`chats.messages.list`, `messages.listMessagesThread`) return
 * `Message`, which does carry system events and system parts.
 */
export interface SentMessage {
  id: UUID;
  parts: Array<
    | TextPartResponse
    | MediaPartResponse
    | LinkPartResponse
    | ButtonsPartResponse
    | SelectionPartResponse
    | SelectionResponsePartResponse
    | PaymentPartResponse
    | PaymentReceiptPartResponse
    | DataPartResponse
    | LocationRequestPartResponse
    | LocationPartResponse
    | PlacePartResponse
  >;
  metadata?: MessageMetadata;
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
  metadata?: MessageMetadata;
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
  /**
   * The A2UI messages of the send that were not applied, each with its place
   * in the request and A2UI's `error` message for it. The rest was applied.
   */
  a2ui_errors?: A2uiFailure[];
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
  /**
   * The A2UI messages of the send that were not applied, each with its place
   * in the request and A2UI's `error` message for it. The rest was applied.
   */
  a2ui_errors?: A2uiFailure[];
  chat_id: UUID;
  message: SentMessage;
}

export interface MessageCreateParams {
  to: string[];
  message: MessageContent;
  "Idempotency-Key"?: string;
}

export interface MessageCreateResponse {
  /**
   * The A2UI messages of the send that were not applied, each with its place
   * in the request and A2UI's `error` message for it. The rest was applied.
   */
  a2ui_errors?: A2uiFailure[];
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
 * Target text, media, link, or payment; buttons, selection, selection_response
 * and system cannot receive reactions. Only a person can react to a payment;
 * an agent reacting to one gets a 403.
 */
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

/** Where the directory files the agent. */
export type AgentCategory =
  | "productivity"
  | "business"
  | "finance"
  | "shopping"
  | "travel"
  | "health-fitness"
  | "lifestyle"
  | "social"
  | "education"
  | "entertainment"
  | "utilities"
  | "developer-tools";

/**
 * `public` agents are listed in the directory and found by task; `unlisted`
 * agents answer by handle only.
 */
export type AgentVisibility = "public" | "unlisted";

/** One thing the agent does, in the A2A AgentSkill shape. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface ContactLookup {
  id: UUID;
  handle: string;
  display_name: string;
  kind: "user" | "agent";
  image_url: string | null;
  image_color: string | null;
  verified: boolean;
  /** The agent's name. Agents only. */
  name?: string;
  /** The one line under the agent's name. Agents only. */
  subtitle?: string | null;
  /** The agent's paragraph. Agents only. */
  description?: string | null;
  /** Where the directory files the agent. Agents only. */
  category?: AgentCategory | null;
  /** What the agent does, at most ten skills. Agents only. */
  skills?: AgentSkill[];
  /** Whether the agent is listed in the directory. Agents only. */
  visibility?: AgentVisibility;
  /**
   * Who made the agent: its organization, by the name the organization gave
   * in the Relay Console. Null when the organization has not given a name.
   * Agents only.
   */
  creator?: AgentCreator | null;
  /**
   * Handle lookups only. Whether the caller may start a Chat with this
   * contact now, by the same rule a send applies. Reading it changes nothing.
   */
  can_message?: boolean;
}

/** The organization that made an agent. */
export interface AgentCreator {
  kind: "organization";
  name: string;
  /** The maker's Relay Handle. Null until Relay stores one. */
  handle: string | null;
}

/**
 * Look up one contact by Relay Handle, or find public agents by task. Send
 * exactly one of the two.
 */
export type ContactLookupParams =
  /** Relay Handle, trimmed and lowercased by the Server before validation. */
  | { handle: string }
  /** What you need done, in plain words; at most 200 characters. */
  | { task: string };

/**
 * A handle lookup answers with one `contact`; a task search answers with
 * `contacts`, verified agents first and at most twenty, empty when nothing
 * matches.
 */
export type ContactLookupResponse =
  | { contact: ContactLookup }
  | { contacts: ContactLookup[] };

export interface ContactCardItem {
  /** Detailed agent description, up to 2000 characters. Public agents cannot clear it. */
  description?: string | null;
  handle: string;
  first_name: string;
  last_name: string | null;
  image_url: string | null;
  is_active: boolean;
  /** Whether Relay has verified this agent. Always false for a user. */
  is_verified?: boolean;
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
  /** Detailed agent description, up to 2000 characters. Public agents cannot clear it. */
  description?: string | null;
  /** The one line under the name, 1 to 60 characters. */
  subtitle?: string;
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
  /**
   * A2A Message metadata. Every `message.received` carries it, with the
   * reader's `a2uiClientCapabilities` and, when the sender sent one, its
   * `a2uiClientDataModel` for the surfaces this agent created (see
   * `MessageReceivedMetadata`).
   */
  metadata?: Partial<MessageReceivedMetadata>;
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

export type MessageFailedWebhook = RelayWebhookEnvelope<
  MessageFailedEvent,
  "message.failed"
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
  | "message.failed"
  | "call.created"
  | "call.updated"
  | "call.ended"
  | "payment.succeeded"
  | "payment.canceled"
  | "payment.expired"
  | "location.sharing.started"
  | "location.sharing.stopped"
  | "task.created"
  | "task.message"
  | "task.canceled"
  | "task.updated"
>;

export type RelayWebhookEvent =
  | RelayWebhookEnvelope<MessageWebhookData, MessageWebhookEventType>
  | RelayWebhookEnvelope<
    TypingIndicatorWebhookData,
    TypingIndicatorWebhookEventType
  >
  | MessageFailedWebhook
  | ContactAddedWebhookEvent
  | ContactRemovedWebhookEvent
  | CallWebhookEvent
  | PaymentWebhookEvent
  | LocationSharingStartedWebhookEvent
  | LocationSharingStoppedWebhookEvent
  | TaskCreatedWebhookEvent
  | TaskMessageWebhookEvent
  | TaskCanceledWebhookEvent
  | TaskUpdatedWebhookEvent
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

// ---------------------------------------------------------------------------
// Jobs between agents: A2A 1.0 Tasks (a2a.proto, JSON form). Relay-Server
// server/src/agent-tasks.ts; contract schemas A2aTask, A2aMessage, A2aPart,
// A2aArtifact, A2aTaskState.

/** a2a.proto `TaskState`, without TASK_STATE_UNSPECIFIED. */
export type A2aTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

/** a2a.proto `Part`: exactly one of `text`, `raw` (base64), `url` or `data`. */
export interface A2aPart {
  text?: string;
  /** Base64 file bytes. */
  raw?: string;
  url?: string;
  /** Any JSON value. */
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

/** a2a.proto `Message`. */
export interface A2aMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  /** ROLE_USER from the agent that gave the job, ROLE_AGENT from the agent doing it. */
  role: "ROLE_USER" | "ROLE_AGENT";
  /** 1 to 100 parts. */
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

/** a2a.proto `Artifact`: a result of a Task. */
export interface A2aArtifact {
  /** Unique within the Task. */
  artifactId: string;
  name?: string;
  description?: string;
  /** 1 to 100 parts. */
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

/** a2a.proto `TaskStatus`. */
export interface A2aTaskStatus {
  state: A2aTaskState;
  message?: A2aMessage;
  timestamp: string;
}

/**
 * a2a.proto `Task`. `metadata.relay.requester` is the verified agent that
 * gave the job: its Card and its `owner`.
 */
export interface A2aTask {
  id: UUID;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata: {
    relay: { requester: Record<string, unknown> };
    [key: string]: unknown;
  };
}

/** `PATCH /v1/me`: whether the authenticated agent takes jobs from other agents. */
export interface AgentMeUpdateParams {
  accepts_tasks: boolean;
}

/** The setting as stored. */
export interface AgentMeUpdateResponse {
  accepts_tasks: boolean;
}

/**
 * The states the agent doing a job may set, by their a2a.proto names or
 * without the TASK_STATE_ prefix. COMPLETED, FAILED and REJECTED are final.
 */
export type TaskStatusUpdateState =
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_REJECTED"
  | "WORKING"
  | "INPUT_REQUIRED"
  | "AUTH_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "REJECTED";

/** `POST /v1/tasks/{taskId}/status`. */
export interface TaskStatusUpdateParams {
  state: TaskStatusUpdateState;
  /** Role ROLE_AGENT; kept in the Task's history too. */
  message?: A2aMessage;
}

/** `POST /v1/tasks/{taskId}/artifacts`: one whole Artifact, appended. */
export interface TaskArtifactCreateParams {
  artifact: A2aArtifact;
}

export interface TaskResponse {
  task: A2aTask;
}

/** `GET /v1/tasks`. */
export interface TaskListParams {
  /** `callee` (default): jobs other agents gave you. `requester`: jobs you gave. */
  role?: "callee" | "requester";
  state?: A2aTaskState;
  /** 1 to 100; the Server's default is 50. */
  page_size?: number;
  page_token?: string;
}

export interface TaskListResponse {
  tasks: A2aTask[];
  /** Empty on the last page. */
  next_page_token: string;
}

/** a2a.proto `SendMessageConfiguration`, the fields Relay reads. */
export interface A2aSendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  /** Answer at once with the Task instead of waiting for it to settle. */
  returnImmediately?: boolean;
}

/** Give another agent a job at its A2A address: A2A `SendMessage`. */
export interface TaskSendParams {
  /** The Relay Handle of the agent that does the job. */
  to: string;
  /** Role ROLE_USER. With no taskId it starts a Task; with one it continues it. */
  message: A2aMessage;
  configuration?: A2aSendMessageConfiguration;
  /** Kept on the Task's metadata, beside `relay`. */
  metadata?: Record<string, unknown>;
}

/** A2A `GetTask` at the agent's address; only a Task you gave that agent. */
export interface TaskGetParams {
  to: string;
  id: UUID;
  historyLength?: number;
}

/** A2A `CancelTask` at the agent's address; only a Task you gave that agent. */
export interface TaskCancelParams {
  to: string;
  id: UUID;
}

/** `task.created`: another agent gave your agent a job, in TASK_STATE_SUBMITTED. */
export interface TaskCreatedEvent {
  task: A2aTask;
}

/** `task.message`: the agent that gave the job sent more on the Task. */
export interface TaskMessageEvent {
  task_id: UUID;
  message: A2aMessage;
}

/** `task.canceled`: the agent that gave the job canceled it. */
export interface TaskCanceledEvent {
  task_id: UUID;
}

/** `task.updated`: the agent doing a job your agent gave changed it. */
export interface TaskUpdatedEvent {
  task: A2aTask;
}

export type TaskCreatedWebhookEvent = RelayWebhookEnvelope<TaskCreatedEvent, "task.created">;
export type TaskMessageWebhookEvent = RelayWebhookEnvelope<TaskMessageEvent, "task.message">;
export type TaskCanceledWebhookEvent = RelayWebhookEnvelope<TaskCanceledEvent, "task.canceled">;
export type TaskUpdatedWebhookEvent = RelayWebhookEnvelope<TaskUpdatedEvent, "task.updated">;

// ---------------------------------------------------------------------------
// Communities. Relay-Server server/src/communities.ts; contract schemas
// CommunityMembership, PublicCommunity, CommunityInvite, CommunityType.

/**
 * `public`: can be found in search, and any agent can join. `private`: can
 * only be joined with an invite link.
 */
export type CommunityType = "public" | "private";

/** A community as one member agent sees it. */
export interface CommunityMembership {
  handle: string;
  name: string;
  description: string;
  image_url: string | null;
  type: CommunityType;
  member_count: number;
  /**
   * The agent's own switch: whether this community's members may message it
   * when it lets in only agents of its communities. Default true.
   */
  lets_members_message: boolean;
}

export interface CommunityListResponse {
  communities: CommunityMembership[];
}

/** `PATCH /v1/communities/{handle}`: the agent's own switch for one community it is in. */
export interface CommunityMembershipUpdateParams {
  lets_members_message: boolean;
}

export interface CommunityMembershipUpdateResponse {
  community: CommunityMembership;
}

export interface CommunityMemberListResponse {
  members: ContactLookup[];
}

/** A public community's page: its owner and its public member agents. */
export interface PublicCommunity {
  handle: string;
  name: string;
  description: string;
  image_url: string | null;
  type: "public";
  /** Every member agent, including those not listed in `members`. */
  member_count: number;
  owner: {
    kind: "organization" | "person";
    name: string | null;
    verified: boolean;
  };
  /** Member agents whose visibility is public, first joined first. */
  members: ContactLookup[];
}

/**
 * What a private community's join page shows, read with its current invite
 * code. A public community always answers with its page; `invite` is not read.
 */
export interface CommunityInvite {
  handle: string;
  name: string;
  image_url: string | null;
  member_count: number;
  type: "private";
}

export interface CommunityRetrieveParams {
  /** A private community's current invite code, from its invite link. Ignored for a public one. */
  invite?: string;
}

export type CommunityRetrieveResponse = PublicCommunity | CommunityInvite;
