import type { RELAY_WEBHOOK_EVENT_TYPES } from "./operations.js";
import type { FormPart, FormPartResponse, FormResponsePart, FormResponsePartResponse } from "./form-types.js";
export type * from "./form-types.js";

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
  /** Agents only: the Rive file it shows in its calls, so the app can load it while the call rings; null when none. */
  rive?: RiveFile | null;
  /**
   * People only: the person's IANA time zone name ("America/Detroit"), as their
   * Relay app last reported it; null until it reports one. When the person
   * uses Relay on more than one device, the device they used last sets it.
   * Timestamps stay in UTC; use this to read them in the person's local time.
   */
  timezone?: string | null;
  /**
   * People only: The person's age range, as their Relay app last reported it: from Apple's
   * Declared Age Range, or from a birth year the person gave once (only the
   * range is kept). Null until the app reports one. A person whose range is not
   * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
   * ask anyone their age.
   */
  age_range?: AgeRange | null;
  /**
   * The person's profile links: at most 5 absolute https URLs, in the order
   * they chose, as Relay normalised them. Empty when they set none. Relay
   * sends no platform name; read the site from the URL. People only.
   */
  links?: string[];
  /**
   * The person's about, as they wrote it in Relay: plain text, at most 160
   * characters. Null when they wrote none. People only.
   */
  about?: string | null;
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

/**
 * A participant's published local track, named on the SFU. `rive` is the
 * agent's data channel that drives the Rive file the phone draws.
 */
export type CallRoomTrackName = "audio" | "video" | "rive";

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

/**
 * Contract `CallRoomRiveFrame`. An agent publishes its `rive` data channel; a
 * person receives the agent's. Sent again while the channel is open, Relay
 * repeats its `id`.
 */
export interface CallRoomRiveFrame {
  type: "rive";
}

export type CallRoomClientFrame =
  | CallRoomJoinFrame
  | CallRoomRiveFrame
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

/**
 * Contract `CallRoomRiveChannelFrame`: the `rive` channel is open on this
 * participant's Session. Open it with `createDataChannel("rive", {
 * negotiated: true, id, ordered: false, maxRetransmits: 0 })`. After a restart
 * onto a new Session, Relay opens it again with a new `id`.
 */
export interface CallRoomRiveChannelFrame {
  type: "rive";
  /** The negotiated SCTP stream id Cloudflare returned. */
  id: number;
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
  | CallRoomRiveChannelFrame
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
  /** Relay's 5% fee on `amount`, in minor units, taken from the payment by Stripe; in subscription mode, the first period's fee. 0 when 5% rounds to nothing. */
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
  /**
   * The person's IANA time zone name ("America/Detroit"), as their Relay app
   * last reported it; null until it reports one. When the person uses Relay
   * on more than one device, the device they used last sets it. Timestamps
   * stay in UTC; use this to read them in the person's local time.
   */
  timezone?: string | null;
  /**
   * The person's age range, as their Relay app last reported it: from Apple's
   * Declared Age Range, or from a birth year the person gave once (only the
   * range is kept). Null until the app reports one. A person whose range is not
   * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
   * ask anyone their age.
   */
  age_range?: AgeRange | null;
  /**
   * The person's profile links: at most 5 absolute https URLs, in the order
   * they chose, as Relay normalised them. Empty when they set none. Relay
   * sends no platform name; read the site from the URL. People only.
   */
  links?: string[];
  /**
   * The person's about, as they wrote it in Relay: plain text, at most 160
   * characters. Null when they wrote none. People only.
   */
  about?: string | null;
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
    /**
     * Null when the person has no Relay account; otherwise the person's IANA
     * time zone name ("America/Detroit"), as their Relay app last reported
     * it. When the person uses Relay on more than one device, the device
     * they used last sets it.
     */
    timezone?: string | null;
    /**
     * Null when the person has no Relay account. The person's age range, as their Relay app last reported it: from Apple's
     * Declared Age Range, or from a birth year the person gave once (only the
     * range is kept). Null until the app reports one. A person whose range is not
     * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
     * ask anyone their age.
     */
    age_range?: AgeRange | null;
    /**
     * The person's profile links: at most 5 absolute https URLs, in the order
     * they chose, as Relay normalised them. Empty when they set none. Relay
     * sends no platform name; read the site from the URL. People only.
     * Null when the person has no Relay account.
     */
    links?: string[] | null;
    /**
     * The person's about, as they wrote it in Relay: plain text, at most 160
     * characters. Null when they wrote none. People only.
     */
    about?: string | null;
  };

export interface AgentChatHandle extends ChatHandleBase {
  kind: "agent";
  /** The Rive file this agent shows in its calls, so an app can load it early; null when it has none. */
  rive?: RiveFile | null;
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

/** Stable row identifier, never derived from the visible label. */
export type SelectionOption = {
  /** 1–24 characters with id; legacy value-only labels allow 1–80. */
  label: string;
  /** Optional row description, 0–72 characters. */
  subtitle?: string;
  /** HTTPS row image, at most 2048 characters. */
  image_url?: string;
} & ({ id: string; value?: string } | { id?: never; value: string });

/** Normalized response aliases are equal; stored legacy labels may have 80 characters. */
export interface SelectionOptionResponse {
  id: string;
  value: string;
  label: string;
  subtitle?: string;
  image_url?: string;
}

export interface SelectionSection {
  /** Trimmed section heading, 1–24 characters. */
  title: string;
  options: SelectionOption[];
}
export interface SelectionSectionResponse {
  title: string;
  options: SelectionOptionResponse[];
}

/** Source-owned answered-bubble text; does not replace portable selected-label text. */
export interface SelectionReplyMessage {
  /** Trimmed text, 1–512 characters. */
  title: string;
  /** Trimmed text, 0–512 characters. */
  subtitle?: string;
}

interface SelectionPresentation {
  type: "selection";
  /** The question: trimmed, 1–60 characters. */
  title: string;
  /** Card second line, trimmed, 0–512 characters. */
  subtitle?: string;
  /** Defaults to true when omitted. False permits exactly one chosen option. */
  multiple?: boolean;
  reply_message?: SelectionReplyMessage;
}

/** Agent-only; exactly one of options or sections, 1–25 total options, up to 10 sections. */
export type SelectionPart = SelectionPresentation & (
  { options: SelectionOption[]; sections?: never }
  | { sections: SelectionSection[]; options?: never }
);

export interface SelectionPartResponse extends SelectionPresentation {
  /** All rows in display order, retained for old clients even when sections are supplied. */
  options: SelectionOptionResponse[];
  sections?: SelectionSectionResponse[];
  /** Durable viewer state; a user answers once. */
  readonly has_responded: boolean;
  /** Viewer-scoped; null before answering, after answer deletion, and for agents. */
  readonly selected_values: string[] | null;
  /** Equal to selected_values, including for legacy options. */
  readonly selected_ids: string[] | null;
  reactions: null;
}

/** User-only metadata after canonical bullet text, with explicit reply_to. */
export interface SelectionResponsePart {
  type: "selection_response";
  /** Unique known identifiers (1–200 characters), in source-option order. */
  selected_values: string[];
  /** When supplied, must equal selected_values in the same order. */
  selected_ids?: string[];
}

/** Metadata only: contributes no visible fallback text. */
export interface SelectionResponsePartResponse extends SelectionResponsePart {
  /** Source-derived, including for replies sent by legacy clients. */
  readonly selected_ids: string[];
  /** Copied by the server from the prompt, never supplied by the replying client. */
  readonly reply_message?: SelectionReplyMessage;
}

/** A card's picture or video, a public https URL, drawn full width at `height` (short 112, medium 168, tall 264 pt). */
export interface RichCardMedia {
  type: "image" | "video";
  url: string;
  thumbnail_url?: string;
  height?: "short" | "medium" | "tall";
}

/**
 * One suggestion on a card; `label` is 1–25 characters. A `reply` comes back
 * as the person's text (the label) plus a `suggestion_response` carrying `id`;
 * every other type is done by the person's phone and sends nothing back.
 */
export type RichCardSuggestion =
  | { type: "reply"; label: string; /** 1–256 characters, unique within the part. */ id: string }
  | { type: "open_url"; label: string; /** http or https only. */ url: string; application?: "browser" | "webview" }
  | { type: "dial"; label: string; /** E.164, e.g. +12223334444. */ phone_number: string }
  | { type: "view_location"; label: string; latitude?: number; longitude?: number; name?: string; query?: string }
  | { type: "share_location"; label: string }
  | {
    type: "create_calendar_event";
    label: string;
    start_time: string;
    end_time: string;
    /** 1–100 characters. */
    title: string;
    /** Up to 500 characters. */
    description?: string;
  };

/** One card: at least one of media, title (1–200) or description (1–2000); up to 4 suggestions. */
export interface CardContent {
  media?: RichCardMedia;
  title?: string;
  description?: string;
  suggestions?: RichCardSuggestion[];
}

/**
 * Agent-only: one card. At most one rich_card or carousel per Message, never
 * beside a selection; a `buttons` part beside it draws as reply pills that
 * leave once the person answers. The card's suggestions persist.
 */
export interface RichCardPart extends CardContent {
  type: "rich_card";
}

export interface RichCardPartResponse extends RichCardPart {
  reactions: Reaction[] | null;
}

/** Agent-only: 2–10 cards swiped sideways, each as tall as the tallest. Reply ids are unique across cards. */
export interface CarouselPart {
  type: "carousel";
  /** small is 180 pt; medium (the default) is as wide as a single card, up to 350 pt. */
  card_width?: "small" | "medium";
  cards: CardContent[];
}

export interface CarouselPartResponse extends CarouselPart {
  card_width: "small" | "medium";
  reactions: Reaction[] | null;
}

/**
 * User-only, after a text part equal to the reply's label, with reply_to
 * naming the card part. The person sends only `id`.
 */
export interface SuggestionResponsePart {
  type: "suggestion_response";
  id: string;
}

/** The reply the person tapped, as the agent reads it: its `id` and its `label`. */
export interface SuggestionResponsePartResponse extends SuggestionResponsePart {
  label: string;
}

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

export type MessagePart =
  | TextPart
  | MediaPart
  | LinkPart
  | ButtonsPart
  | SelectionPart
  | SelectionResponsePart
  | RichCardPart
  | CarouselPart
  | SuggestionResponsePart
  | FormPart
  | FormResponsePart
  | PaymentPart
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
  /**
   * People only: the person's IANA time zone name ("America/Detroit"), as their
   * Relay app last reported it; null until it reports one. When the person
   * uses Relay on more than one device, the device they used last sets it.
   * Timestamps stay in UTC; use this to read them in the person's local time.
   */
  timezone?: string | null;
  /**
   * People only: The person's age range, as their Relay app last reported it: from Apple's
   * Declared Age Range, or from a birth year the person gave once (only the
   * range is kept). Null until the app reports one. A person whose range is not
   * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
   * ask anyone their age.
   */
  age_range?: AgeRange | null;
  /**
   * The person's profile links: at most 5 absolute https URLs, in the order
   * they chose, as Relay normalised them. Empty when they set none. Relay
   * sends no platform name; read the site from the URL. People only.
   */
  links?: string[];
  /**
   * The person's about, as they wrote it in Relay: plain text, at most 160
   * characters. Null when they wrote none. People only.
   */
  about?: string | null;
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

/** Who did it, with the name and picture a client shows beside the event. */
export interface SystemEventActor extends SystemEventParty {
  /** First and last name joined by a space; empty when the Contact has none. */
  display_name: string;
  image_url: string | null;
  image_color: string | null;
}

export interface SystemEvent {
  type: SystemEventType;
  actor: SystemEventActor;
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
  | RichCardPartResponse
  | CarouselPartResponse
  | SuggestionResponsePartResponse
  | FormPartResponse
  | FormResponsePartResponse
  | PaymentPartResponse
  | PaymentReceiptPartResponse
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
    | RichCardPartResponse
    | CarouselPartResponse
    | SuggestionResponsePartResponse
    | FormPartResponse
    | FormResponsePartResponse
    | PaymentPartResponse
    | PaymentReceiptPartResponse
      | LocationRequestPartResponse
    | LocationPartResponse
    | PlacePartResponse
  >;
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

/**
 * Send handle to recommend an agent, user_id to share a person, or neither to
 * share the authenticated agent's own card. Never both.
 */
export interface ChatShareContactCardParams {
  /**
   * The agent to recommend, trimmed and lowercased by the Server. It must be
   * active, Public or Unlisted, and let people message it; anything else is
   * the same 404 as an unknown handle.
   */
  handle?: string;
  /**
   * The person to share: their id as you see it in a chat
   * (`system_event.actor.id` or the chat's handles). They must have sent a
   * message in a chat with you and not blocked you, and the target chat needs
   * an active person none of whom has blocked or been blocked by them;
   * anything else is the same 404. Ask both people first. Their card is a
   * snapshot: id, handle, name, photo, links and about.
   */
  user_id?: UUID;
}

export interface ChatShareContactCardOptions extends RequestOptions {
  /** 1 to 255 characters. The same key and body replay with nothing shared; another body is 409. */
  idempotencyKey?: string;
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

/**
 * A person's age range: the bands Apple's Declared Age Range answers for the
 * age gates 13, 16 and 18.
 */
export type AgeRange = "under_13" | "13_15" | "16_17" | "18_plus";

/**
 * Who an agent is for, set in the Relay Console. Relay refuses an 18_plus
 * agent to every person whose age range is not 18_plus (error code 2035) and
 * leaves it out of their directory, search and suggestions.
 */
export type AgentAgeRating = "everyone" | "18_plus";

/** One thing the agent does. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface DirectorySearchParams {
  q?: string;
  category?: AgentCategory;
  limit?: number;
  sort?: "name" | "newest";
}

export interface AgentMetrics {
  chats_people: number;
  chats_agents: number;
  chats_people_30d: number;
  chats_agents_30d: number;
  reply_rate_30d: number | null;
  reply_minutes_30d: number | null;
  messages_total: number;
  since: string;
}

export interface AgentRatingAverage {
  average: number | null;
  count: number;
}

export interface DirectoryAgent {
  handle: string;
  name: string;
  subtitle: string | null;
  category: AgentCategory;
  image_url: string | null;
  image_color: string | null;
  accent_color: string | null;
  verified: boolean;
  provider: { name: string | null; url: string | null; verified: boolean };
  metrics: AgentMetrics;
  rating: AgentRatingAverage;
}

export interface DirectorySearchResponse {
  agents: DirectoryAgent[];
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
  /**
   * People only: the person's IANA time zone name ("America/Detroit"), as
   * their Relay app last reported it; null until it reports one. Timestamps
   * stay in UTC; use this to read them in the person's local time.
   */
  timezone?: string | null;
  /**
   * People only: The person's age range, as their Relay app last reported it: from Apple's
   * Declared Age Range, or from a birth year the person gave once (only the
   * range is kept). Null until the app reports one. A person whose range is not
   * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
   * ask anyone their age.
   */
  age_range?: AgeRange | null;
  /**
   * The person's profile links: at most 5 absolute https URLs, in the order
   * they chose, as Relay normalised them. Empty when they set none. Relay
   * sends no platform name; read the site from the URL. People only.
   */
  links?: string[];
  /**
   * The person's about, as they wrote it in Relay: plain text, at most 160
   * characters. Null when they wrote none. People only.
   */
  about?: string | null;
  /** Who the agent is for: everyone, or only people whose age range is 18_plus. Agents only. */
  age_rating?: AgentAgeRating;
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
  /** Contact id, such as a shared Contact Card's id; its handle may since have changed. */
  | { id: UUID }
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

/**
 * Contract `RiveFile`: the Rive file an agent shows in its calls (a
 * character, a quiz, a game, a chart). The app draws `artboard`, runs
 * `state_machine` and binds `view_model`; the agent drives it live with
 * `transport.rive()` from `@relaymessenger/sdk/calls`. A null name means the
 * file's default.
 */
export interface RiveFile {
  /** The `.riv` Relay hosts, at a permanent address whose bytes never change. */
  file: string;
  artboard: string | null;
  state_machine: string | null;
  view_model: string | null;
}

/**
 * Contract `RiveFileInput`: `attachment_id` for a new file (this agent's
 * completed upload, a Rive file of at most 10 MB with every image and font
 * embedded), or `file` with the address the card already holds to change only
 * the names. The names you send replace all three; omitted or null means the
 * file's default.
 */
export type RiveFileInput =
  & { artboard?: string | null; state_machine?: string | null; view_model?: string | null }
  & ({ attachment_id: UUID; file?: never } | { file: string; attachment_id?: never });

export interface ContactCardItem {
  /**
   * The shared Contact's id, only on a card shared by handle or user_id. Open
   * an agent by this id (`contacts.lookup({ id })`); the handle may since have changed.
   */
  id?: UUID;
  /** The shared agent's subtitle when it was shared, only on a card shared by handle. */
  subtitle?: string | null;
  /**
   * Relay link that opens the shared agent's chat, only on a card shared by
   * handle. Such a card is a snapshot taken when it was shared and never changes.
   */
  url?: string;
  /** Detailed agent description, up to 2000 characters. Public agents cannot clear it. */
  description?: string | null;
  /** Null only on a shared person's card after they deleted their account. */
  handle: string | null;
  first_name: string;
  last_name: string | null;
  image_url: string | null;
  is_active: boolean;
  /** Whether Relay has verified this agent. Always false for a user. */
  is_verified?: boolean;
  /**
   * A shared person's profile links when the card was shared, only on a
   * person's card. A person's card carries id, handle, name, photo, links and
   * about, and nothing else.
   */
  links?: string[];
  /**
   * A shared person's about when the card was shared, at most 160
   * characters, or null when they wrote none. Only on a person's card.
   */
  about?: string | null;
  /** An agent's Rive file for calls, or null when it has none. Only on an agent's card. */
  rive?: RiveFile | null;
  kind: "user" | "agent";
}

/**
 * What `POST` and `PATCH /v1/contact_card` return: the agent's own card, whose
 * handle is never null. (`GET /v1/contact_card` returns `ContactCardItem`, the
 * contract's one schema for every card, shared ones included.)
 */
export interface SetContactCardResponse {
  /** Detailed agent description, up to 2000 characters. Public agents cannot clear it. */
  description?: string | null;
  first_name: string;
  last_name: string | null;
  image_url: string | null;
  /** Dominant colour of the picture, six uppercase hex digits; null when Relay has none. */
  image_color: string | null;
  /** The agent's Rive file for calls, or null when it has none. */
  rive?: RiveFile | null;
  is_active: boolean;
  handle: string;
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
  /** Set the Rive file shown in calls, change its names, or clear it with null (which deletes the hosted file). */
  rive?: RiveFileInput | null;
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

/** `allow` is Always Allow; `deny` is Never Allow. */
export type AgentAccessRule = "allow" | "deny";

/**
 * The authenticated agent's Always Allow and Never Allow lists, newest first.
 * A contact on Always Allow may start a Chat with the agent whatever its
 * owner set for people and other agents; a contact on Never Allow may not.
 * The agent's owner is always allowed and is on neither list.
 */
/** "Log in with Relay" scopes: `openid` and `profile` always, `email` and `phone` optional. */
/**
 * An OpenID Connect scope a Log in with Relay client may ask for. `birthdate`
 * asks for the person's birthday as the OpenID `birthdate` claim (YYYY-MM-DD,
 * or 0000-MM-DD when they gave no year).
 */
export type OAuth2Scope = "openid" | "profile" | "email" | "phone" | "birthdate";

/** The agent's OAuth2 client for Log in with Relay. `client_id` is the agent's ID. */
export interface OAuth2Client {
  client_id: string;
  redirect_uris: string[];
  scopes: OAuth2Scope[];
  created_at: string;
  updated_at: string;
}

export interface OAuth2ClientResponse {
  client: OAuth2Client;
  /** The client secret (`rel_cs_...`), only when the client was just made or its secret was just reset. */
  client_secret?: string;
}

export interface OAuth2ClientUpdateParams {
  /** Replaces every redirect. Up to 10 https URLs (http only on localhost). */
  redirect_uris?: string[];
  /** Replaces the scopes. `openid` and `profile` are always kept. */
  scopes?: OAuth2Scope[];
}

export interface AgentAccessLists {
  allow: ContactLookup[];
  deny: ContactLookup[];
}

export interface AgentAccessSetParams {
  rule: AgentAccessRule;
}

/** The contact, and the one list it is now on. */
export interface AgentAccessEntry {
  rule: AgentAccessRule;
  contact: ContactLookup;
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
  /**
   * The person's IANA time zone name ("America/Detroit"), as their Relay app
   * last reported it; null until it reports one. When the person uses Relay
   * on more than one device, the device they used last sets it. Timestamps
   * stay in UTC; use this to read them in the person's local time.
   */
  timezone: string | null;
  /**
   * The person's age range, as their Relay app last reported it: from Apple's
   * Declared Age Range, or from a birth year the person gave once (only the
   * range is kept). Null until the app reports one. A person whose range is not
   * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
   * ask anyone their age.
   */
  age_range: AgeRange | null;
  /**
   * The person's profile links: at most 5 absolute https URLs, in the order
   * they chose, as Relay normalised them. Empty when they set none. Relay
   * sends no platform name; read the site from the URL. People only.
   */
  links: string[];
  /**
   * The person's about, as they wrote it in Relay: plain text, at most 160
   * characters. Null when they wrote none. People only.
   */
  about: string | null;
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

/** A person who administers an agent (`OwnerPerson`, contracts/relay-v1-openapi.yaml). */
export interface OwnerPerson {
  /** The person's Contact identifier. */
  id: UUID;
  /** The person's Relay Handle. */
  handle: string;
  /** The person's display name. */
  display_name: string;
  /**
   * the person's IANA time zone name ("America/Detroit"), as their
   * Relay app last reported it; null until it reports one. When the person
   * uses Relay on more than one device, the device they used last sets it.
   * Timestamps stay in UTC; use this to read them in the person's local time.
   */
  timezone?: string | null;
  /**
   * The person's age range, as their Relay app last reported it: from Apple's
   * Declared Age Range, or from a birth year the person gave once (only the
   * range is kept). Null until the app reports one. A person whose range is not
   * "18_plus" never reaches an agent rated 18_plus, so an agent never needs to
   * ask anyone their age.
   */
  age_range?: AgeRange | null;
  /**
   * The person's profile links: at most 5 absolute https URLs, in the order
   * they chose, as Relay normalised them. Empty when they set none. Relay
   * sends no platform name; read the site from the URL. People only.
   */
  links?: string[];
  /**
   * The person's about, as they wrote it in Relay: plain text, at most 160
   * characters. Null when they wrote none. People only.
   */
  about?: string | null;
}

/** `GET /v1/me`: the agent the Agent Token authenticates, and who owns it (`AgentMe`). */
export interface AgentMe {
  id: UUID;
  handle: string;
  kind: "agent";
  display_name: string;
  /** Who owns this agent, as every Handle of it names it. Null for an agent no organization or person owns. */
  owner: HandleOwner | null;
  /**
   * The people who administer this agent: the owning person, or for an
   * organization's agent the person who issued the calling Agent Token.
   * Empty when none can be resolved, for example when that person has no
   * Relay app account yet.
   */
  owner_people: OwnerPerson[];
  /**
   * Whether this server takes Calls. When false, `calls.create` is refused
   * with 503 (error code 3006) and nothing is written, so do not start or
   * offer a Call.
   */
  calls_enabled: boolean;
}
