/**
 * Relay v1 wire types used by this adapter.
 *
 * Every Relay object here is `@relaymessenger/sdk`'s own type under the name
 * this adapter has always exported, so a part or field the server adds
 * reaches the adapter with the SDK, never by a second hand-written copy. The
 * import is type-only: the SDK adds nothing to the adapter's runtime.
 */
import type * as Sdk from "@relaymessenger/sdk";

export const RELAY_API_VERSION = "v1" as const;
export const RELAY_WEBHOOK_VERSION = "2026-08-30" as const;

/**
 * The webhook event types, kept as a runtime list here so the adapter never
 * loads the SDK at runtime. The type check below refuses any drift from the
 * SDK's own list.
 */
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
  "rating.created",
  "rating.updated",
  "rating.deleted",
] as const;

export type RelayWebhookEventType =
  (typeof RELAY_WEBHOOK_EVENT_TYPES)[number];

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
/** Compile-time guard: the local event list equals the SDK's. */
export type RelayWebhookEventTypesMatchSdk =
  Same<RelayWebhookEventType, Sdk.WebhookEventType> extends true ? true : never;
const eventTypesMatchSdk: RelayWebhookEventTypesMatchSdk = true;
void eventTypesMatchSdk;

export type RelayWebhookEnvelope<TData = Record<string, unknown>> =
  Sdk.RelayWebhookEnvelope<TData>;

export type RelayChatActivity = Sdk.ChatActivity;
export type RelayChatHandle = Sdk.ChatHandle;
export type RelayReactionType = Sdk.ReactionType;
export type RelayReaction = Sdk.Reaction;
export type RelayReplyTo = Sdk.ReplyTo;

// Parts an agent sends.
export type RelayTextPart = Sdk.TextPart;
export type RelayMediaPart = Sdk.MediaPart;
export type RelayLinkPart = Sdk.LinkPart;
export type RelayButtonItem = Sdk.ButtonItem;
export type RelayButtonsPart = Sdk.ButtonsPart;
export type RelaySelectionPart = Sdk.SelectionPart;
export type RelaySelectionResponsePart = Sdk.SelectionResponsePart;
export type RelayRichCardMedia = Sdk.RichCardMedia;
export type RelayRichCardSuggestion = Sdk.RichCardSuggestion;
export type RelayCardContent = Sdk.CardContent;
export type RelayRichCardPart = Sdk.RichCardPart;
export type RelayCarouselPart = Sdk.CarouselPart;
export type RelaySuggestionResponsePart = Sdk.SuggestionResponsePart;
export type RelayFormPart = Sdk.FormPart;
export type RelayFormField = Sdk.FormField;
export type RelayFormAnswers = Sdk.FormAnswers;
export type RelayFormResponsePart = Sdk.FormResponsePart;
export type RelayPaymentPart = Sdk.PaymentPart;
export type RelayRatingRequestPart = Sdk.RatingRequestPart;
export type RelayPlacePart = Sdk.PlacePart;

/** Every part a Relay Message accepts on send. */
export type RelayOutgoingPart = Sdk.MessagePart;

// Parts as Relay returns them.
export type RelayTextPartResponse = Sdk.TextPartResponse;
export type RelayMediaPartResponse = Sdk.MediaPartResponse;
export type RelayLinkPartResponse = Sdk.LinkPartResponse;
export type RelayButtonsPartResponse = Sdk.ButtonsPartResponse;
export type RelaySelectionPartResponse = Sdk.SelectionPartResponse;
export type RelaySelectionResponsePartResponse = Sdk.SelectionResponsePartResponse;
export type RelayRichCardPartResponse = Sdk.RichCardPartResponse;
export type RelayCarouselPartResponse = Sdk.CarouselPartResponse;
export type RelaySuggestionResponsePartResponse = Sdk.SuggestionResponsePartResponse;
export type RelayFormPartResponse = Sdk.FormPartResponse;
export type RelayFormResponsePartResponse = Sdk.FormResponsePartResponse;
export type RelayPaymentPartResponse = Sdk.PaymentPartResponse;
export type RelayPaymentReceiptPartResponse = Sdk.PaymentReceiptPartResponse;
export type RelayLocationRequestPartResponse = Sdk.LocationRequestPartResponse;
export type RelayLocationPartResponse = Sdk.LocationPartResponse;
export type RelayPlacePartResponse = Sdk.PlacePartResponse;
export type RelayRatingRequestPartResponse = Sdk.RatingRequestPartResponse;
export type RelaySystemPartResponse = Sdk.SystemPartResponse;

/** Every part a Relay Message can carry when read. */
export type RelayMessagePartResponse = Sdk.MessagePartResponse;

export type RelaySystemEvent = Sdk.SystemEvent;
export type RelayContactCard = Sdk.ContactCardItem;

export type RelayMessage = Sdk.Message;
export type RelayWebhookMessageEvent = Sdk.MessageWebhookData;
export type RelaySentMessage = Sdk.SentMessage;
export type RelaySendMessageResponse = Sdk.MessageSendResponse;

/** `GET /v1/chats/{chatId}/messages`. */
export interface RelayGetMessagesResult {
  messages: RelayMessage[];
  next_cursor?: string | null;
}

export type RelayChat = Sdk.Chat;

/** `reaction.added` and `reaction.removed` data. */
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

export type RelayAttachment = Sdk.Attachment;
export type RelayAttachmentAllocation = Sdk.AttachmentCreateResponse;

export type RelayPaymentCategory = Sdk.PaymentCategory;
export type RelayPaymentStatus = Sdk.PaymentStatus;
export type RelayPaymentMode = Sdk.PaymentMode;
export type RelayPaymentRecurring = Sdk.PaymentRecurring;
export type RelayCreatePaymentRequest = Sdk.PaymentRequestCreateParams;
export type RelayPaymentRequest = Sdk.PaymentRequest;
export type RelayPaymentRequestList = Sdk.PaymentRequestListResponse;

/** `POST /v1/chats/{chatId}/location/request`. */
export type RelayLocationRequestResponse = Sdk.LocationRequestResponse;
/** `GET /v1/chats/{chatId}/location`: one GeoJSON Feature per person sharing. */
export type RelayChatLocation = Sdk.GetChatLocationResponse;
export type RelayLocationFeature = Sdk.LocationFeature;

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
