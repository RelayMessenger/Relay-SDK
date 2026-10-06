import { action, type Action } from "@cloudflare/think";
import { decodeRelayThreadId } from "@relaymessenger/chat-sdk-adapter";
import type Relay from "@relaymessenger/sdk";
import {
  BUTTONS_GUIDANCE,
  type ChatSendVoicememoResponse,
  type MessagePart,
  type PaymentRequest,
  type RequestOptions,
  RelayAPIError,
  SELECTION_GUIDANCE,
  partsWithSelection,
  selectionPart,
} from "@relaymessenger/sdk";
import type { StopCondition, ToolSet } from "ai";
import { z } from "zod";

import { RelayGenerationActivities } from "./activity";
import {
  PAYMENT_CATEGORIES,
  PAYMENT_CHAT_METADATA_KEY,
  PAYMENT_DESCRIPTION_MAX,
  type PaymentCategory,
  RelayPaymentRefused,
  executePaymentRequest,
  paymentRequestInputSchema,
} from "./payment";
import { readRelayLocation, requestRelayLocation } from "./location";
import { relayCallIdempotencyKey, startRelayCall } from "./call-start";
import { type CardInput, RelayCardRefused, cardContent, cardIssues, cardSchema } from "./cards";
import {
  changeGroup,
  findAgents,
  findAgentsInputSchema,
  groupInputSchema,
  shareContactCard,
} from "./chat-tools";
import { abortableDelay, compositionDelayMs, createRelayClient, type RelayClientEnv } from "./typing";
import type { RelayChatTimingPhase } from "./timing";

/** One option of a selection: a stable value for the app, a label for the person. */
export interface SendSelectionOption {
  value: string;
  label: string;
}

/** One button under a text Message: a label, and for a link button, the page it opens. */
export interface SendButton {
  label: string;
  url?: string;
}

export type SendInput =
  | {
    kind: "text";
    // Buttons may travel without words: the server takes a buttons-only
    // Message and the app draws the pills with no bubble above them. The
    // refinement below is what holds "text, or buttons, or both".
    text?: string;
    buttons?: SendButton[];
    selection?: SendSelectionOption[];
    title?: string;
    /** Quote-reply to the Message this turn answers. */
    reply?: boolean;
    /** No banner and no sound on the person's phone. */
    silent?: boolean;
    prompt?: never;
    caption?: never;
    style?: never;
  }
  | {
    kind: "place";
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    text?: string;
    prompt?: never;
    caption?: never;
    style?: never;
  }
  | {
    kind: "image";
    prompt: string;
    caption?: string;
    activity?: string;
    activity_emoji?: string;
    text?: never;
    style?: never;
  }
  | {
    kind: "voice_memo";
    text: string;
    style?: string;
    activity?: string;
    activity_emoji?: string;
    prompt?: never;
    caption?: never;
  }
  | {
    kind: "link";
    url: string;
    text?: string;
    prompt?: never;
    caption?: never;
    style?: never;
  }
  | {
    kind: "payment";
    description: string;
    category: PaymentCategory;
    mode?: "payment" | "subscription";
    amount?: number;
    currency?: string;
    price_id?: string;
    image_url?: string;
    text?: never;
    url?: never;
    prompt?: never;
    caption?: never;
    style?: never;
    buttons?: never;
    selection?: never;
  }
  | {
    kind: "rich_card";
    /** Exactly one card. */
    cards: CardInput[];
    text?: string;
  }
  | {
    kind: "carousel";
    /** 2 to 10 cards. */
    cards: CardInput[];
    card_width?: "small" | "medium";
    text?: string;
  };

const CARD_KINDS = new Set(["rich_card", "carousel"]);

// Vertex requires every functionDeclaration.parameters root to be an OBJECT.
// Keep the wire schema as one object and enforce the discriminated field rules
// in refinement; a root discriminatedUnion serializes as oneOf and Vertex
// rejects the entire model request before inference.
// The server's button limits (Discord's): 1 to 5 items, label 1 to 80,
// url at most 2,048. A tap comes back as a text Message equal to the label.
const sendButtonSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z.string().max(2_048).regex(/^https?:\/\//u).optional(),
}).strict();

/** Every kind of Message the send Action can carry. */
export const RELAY_SEND_KINDS = [
  "text", "image", "voice_memo", "link", "place", "payment", "rich_card", "carousel",
] as const;
export type RelaySendKind = (typeof RELAY_SEND_KINDS)[number];

/**
 * The send Action's input schema, offering only `kinds`: an agent with no
 * image or voice generator is never offered image or voice_memo.
 */
export function relaySendInputSchema(
  kinds: readonly RelaySendKind[] = RELAY_SEND_KINDS,
): z.ZodType<SendInput> {
  return z.object({
  kind: z.enum(kinds as [RelaySendKind, ...RelaySendKind[]]),
  // Empty words are no words: the SDK builds no text part for them, and a
  // model that fills every field sends "" rather than leaving text out.
  text: z.string().trim().max(10_000).optional().describe(
    "The words of the Message. Leave it out, or empty, when buttons carry the whole turn. With kind rich_card or "
    + "carousel, optional words shown above the card.",
  ),
  // The server's link part: one absolute URL of at most 2,048 characters,
  // alone in its Message. With text, the words go first as their own Message.
  url: z.string().trim().max(2_048).regex(/^https?:\/\/\S+$/u).optional().describe(
    "With kind link only: one absolute http or https URL the person will look at or read, sent as its own Message and "
    + "drawn as a card with the page's title and image. Give text to say something first; it goes as its own Message "
    + "before the card. A page the person acts on is a url button under a text Message instead.",
  ),
  buttons: z.array(sendButtonSchema).min(1).max(5).optional().describe(
    "With kind text only: 1 to 5 buttons drawn under the Message. Each has a label of 1 to 80 characters; "
    + "a url button opens the page inside the app instead of sending its label. " + BUTTONS_GUIDANCE,
  ),
  // The server's selection limits: 1 to 25 options, each a unique ASCII
  // token value (1 to 100 characters) and a trimmed label of 1 to 80. The
  // answer comes back as the chosen labels plus their values.
  selection: z.array(z.object({
    value: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(25).optional().describe(
    "With kind text only, beside a required title and never with buttons: 1 to 25 options the person "
    + "checks in a sheet and submits once. Each option has a stable value (letters, digits, and . _ : -, starting with a "
    + "letter or digit, unique) and a readable label of 1 to 80 characters. " + SELECTION_GUIDANCE,
  ),
  title: z.string().trim().min(1).max(60).optional().describe(
    "With a selection only, and required with it: the selection's title, shown on the card and at the top of the sheet: "
    + "1 to 60 characters, a few words, e.g. \"Pizza toppings\". Anything else goes in text, shown above the card.",
  ),
  // MessageContent.reply_to and .silent (the developer contract).
  reply: z.boolean().optional().describe(
    "With kind text only, optional: true to send the Message as a quote-reply to the Message you are answering, "
    + "when it answers one point of several.",
  ),
  silent: z.boolean().optional().describe(
    "With kind text only, optional: true to deliver the Message with no banner and no sound on the person's phone.",
  ),
  // The server's place part (PlacePart, WhatsApp Cloud API's location fields).
  latitude: z.number().min(-90).max(90).optional().describe(
    "With kind place: the place's latitude in degrees. Send a place to show a spot on a map, drawn as a pin card.",
  ),
  longitude: z.number().min(-180).max(180).optional().describe("With kind place: the place's longitude in degrees."),
  name: z.string().trim().min(1).max(256).optional().describe("With kind place, optional: the place's name."),
  address: z.string().trim().min(1).max(256).optional().describe("With kind place, optional: the place's address."),
  prompt: z.string().trim().min(1).max(4_000).optional(),
  caption: z.string().trim().min(1).max(10_000).optional(),
  style: z.string().trim().min(1).max(500).optional(),
  // Relay's chat activity (PUT /v1/chats/{chatId}/activity): 1 to 21 visible
  // characters and one optional emoji, shown under the agent's name while it
  // works. Written by the model like every other word the person sees.
  activity: z.string().trim().min(1).max(21).optional().describe(
    "With kind image or voice_memo: the short status the person sees under your name while you make it, "
    + "1 to 21 characters in your own words, e.g. what you are drawing. Leave it out to show nothing.",
  ),
  activity_emoji: z.string().trim().min(1).max(16).optional().describe(
    "With activity only, optional: one emoji shown beside it.",
  ),
  // A payment request (POST /v1/payment_requests). The checkout link is never
  // a model field: it is whatever the create call returns, sent back as-is.
  description: z.string().trim().min(1).max(PAYMENT_DESCRIPTION_MAX).optional().describe(
    `With kind payment only: what is being paid for, the card's title, 1 to ${PAYMENT_DESCRIPTION_MAX} characters.`,
  ),
  category: z.enum(PAYMENT_CATEGORIES).optional().describe(
    "With kind payment only: physical_goods, digital_goods, or donation.",
  ),
  mode: z.enum(["payment", "subscription"]).optional().describe(
    "With kind payment only: payment (the default) charges amount in currency once; subscription starts an "
    + "auto-renewing subscription from price_id.",
  ),
  amount: z.number().int().min(1).optional().describe(
    "With kind payment in payment mode: the price in the currency's minor units (cents for usd), an integer.",
  ),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/u).optional().describe(
    "With kind payment in payment mode: the 3-letter currency code, e.g. usd.",
  ),
  price_id: z.string().trim().min(1).optional().describe(
    "With kind payment in subscription mode: a recurring Stripe Price id (price_...) on your organization's Stripe account.",
  ),
  image_url: z.string().trim().max(2_048).regex(/^https:\/\/\S+$/u).optional().describe(
    "With kind payment only, optional: an https picture of what is being paid for, shown on the card.",
  ),
  // Relay's rich_card and carousel parts (@relaymessenger/sdk CardContent);
  // cards.ts builds them and holds their rules.
  cards: z.array(cardSchema).min(1).max(10).optional().describe(
    "With kind rich_card, exactly one card; with kind carousel, 2 to 10 cards the person swipes through.",
  ),
  card_width: z.enum(["small", "medium"]).optional().describe(
    "With kind carousel only, optional: small cards (180 pt) or medium (the default, as wide as one card).",
  ),
}).strict().superRefine((value, context) => {
  const required = value.kind === "image"
    ? "prompt"
    : value.kind === "link"
    ? "url"
    : value.kind === "place"
    ? "latitude"
    : value.kind === "payment"
    ? "description"
    : CARD_KINDS.has(value.kind)
    ? "cards"
    : "text";
  // A buttons-only Message is one the server takes, so buttons stand in for
  // the words when the whole turn is the choice. A payment has several required
  // fields at once, checked below instead of through this single-field rule.
  // A coordinate of 0 is a real place, so place checks presence, not truth.
  const missing = value.kind === "place" ? value.latitude === undefined : !value[required];
  if (
    value.kind !== "payment"
    && missing
    && !(value.kind === "text" && (value.buttons?.length || value.selection?.length))
  ) {
    context.addIssue({
      code: "custom",
      path: [required],
      message: value.kind === "text"
        ? "text is required for text, unless buttons or a selection are sent on their own"
        : `${required} is required for ${value.kind}`,
    });
  }
  if (value.kind === "place" && value.longitude === undefined) {
    context.addIssue({ code: "custom", path: ["longitude"], message: "longitude is required for place" });
  }
  if ((value.kind === "rich_card" || value.kind === "carousel") && value.cards !== undefined) {
    for (const issue of cardIssues(value.kind, value.cards)) context.addIssue({ code: "custom", ...issue });
  }
  if (value.kind === "voice_memo" && (value.text?.length ?? 0) > 4_000) {
    context.addIssue({
      code: "custom",
      path: ["text"],
      message: "text must be at most 4,000 characters for voice_memo",
    });
  }
  if (value.kind === "payment") {
    // The contract's per-mode rules: payment mode needs amount and currency,
    // subscription mode needs price_id and takes neither.
    const subscription = value.mode === "subscription";
    const needed = subscription
      ? ["description", "category", "price_id"] as const
      : ["description", "category", "amount", "currency"] as const;
    for (const field of needed) {
      if (value[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for payment${subscription ? " in subscription mode" : ""}`,
        });
      }
    }
    for (const field of subscription ? ["amount", "currency"] as const : ["price_id"] as const) {
      if (value[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is not valid for payment in ${subscription ? "subscription" : "payment"} mode`,
        });
      }
    }
  }
  if (value.title !== undefined && (value.kind !== "text" || value.selection === undefined)) {
    context.addIssue({ code: "custom", path: ["title"], message: "title is only valid with a selection" });
  }
  if (value.selection !== undefined && value.kind === "text") {
    // One source of truth for the option rules: the SDK's own validator,
    // the same one every other Relay runtime authors through.
    // The title is required here too: the SDK refuses a selection without one.
    const checked = selectionPart({ type: "selection", title: value.title, options: value.selection });
    if (typeof checked === "string") {
      context.addIssue({ code: "custom", path: [value.title === undefined ? "title" : "selection"], message: checked });
    }
    if (value.buttons !== undefined) {
      context.addIssue({ code: "custom", path: ["selection"], message: "selection cannot be sent with buttons" });
    }
  }
  const paymentFields = new Set([
    "description", "category", "mode", "amount", "currency", "price_id", "image_url",
  ]);
  // Words beside a card are a text part before it, which the chat list and
  // notification show.
  const cardFields = value.kind === "rich_card"
    ? new Set(["text"])
    : value.kind === "carousel"
    ? new Set(["text", "card_width"])
    : new Set<string>();
  for (const field of [
    "text", "prompt", "caption", "style", "activity", "activity_emoji", "buttons", "selection", "url",
    "description", "category", "mode", "amount", "currency", "price_id", "image_url",
    "cards", "card_width",
    "reply", "silent", "latitude", "longitude", "name", "address",
  ] as const) {
    const allowed = field === required
      || (value.kind === "text" && (field === "buttons" || field === "selection" || field === "reply" || field === "silent"))
      || (value.kind === "place" && (field === "longitude" || field === "name" || field === "address" || field === "text"))
      || (value.kind === "image" && field === "caption")
      || (value.kind === "voice_memo" && field === "style")
      || ((value.kind === "image" || value.kind === "voice_memo") && field === "activity")
      || ((value.kind === "image" || value.kind === "voice_memo")
        && field === "activity_emoji" && value.activity !== undefined)
      || (value.kind === "link" && field === "text")
      || (value.kind === "payment" && paymentFields.has(field))
      || cardFields.has(field);
    if (!allowed && value[field] !== undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is not valid for ${value.kind}`,
      });
    }
  }
}) as unknown as z.ZodType<SendInput>;
}

export const sendInputSchema = relaySendInputSchema();

const reactionInputSchema = z.object({
  type: z.enum([
    "love",
    "like",
    "dislike",
    "laugh",
    "emphasize",
    "question",
    "custom",
  ]),
  custom_emoji: z.string().trim().min(1).max(32).optional(),
  // POST /v1/messages/{id}/reactions takes operation add or remove.
  remove: z.boolean().optional().describe(
    "true to take back your own reaction of this type instead of adding one.",
  ),
}).strict().superRefine((value, context) => {
  if (value.type === "custom" && !value.custom_emoji) {
    context.addIssue({
      code: "custom",
      message: "custom_emoji is required for a custom reaction",
    });
  }
  if (value.type !== "custom" && value.custom_emoji) {
    context.addIssue({
      code: "custom",
      message: "custom_emoji is only valid for a custom reaction",
    });
  }
});
export type ReactionInput = z.infer<typeof reactionInputSchema>;

export interface RelayTurnIdentity {
  chatId: string;
  eventId: string;
  /**
   * The Message and part the react Action targets when it is not the turn's
   * own Message: after a person's reaction, the part they reacted to.
   */
  reactTo?: { messageId: string; partIndex: number };
  /**
   * The Message a quote-reply answers: the person's Message this turn answers,
   * or the part they reacted to. An event turn (an unanswered Call) has none.
   */
  replyTo?: { messageId: string; partIndex: number };
  /**
   * Wall clock (ms) when this turn's typing indicator went up. The composing
   * pause counts from here, as a person's typing starts when the dots do: a
   * turn whose model already took longer than the pause sends at once. Absent
   * (a turn with no typing indicator), it counts from the send.
   */
  composingSince?: number;
}

/** An image the agent's own image model made, ready to upload. */
export interface RelayGeneratedImage {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png" | "image/webp";
}

/** A spoken voice memo the agent's own speech model made, as WAV. */
export interface RelayGeneratedVoiceMemo {
  bytes: Uint8Array;
  contentType: "audio/x-wav";
  durationMs: number;
}

/**
 * The agent's own media models. Relay sends what they make; it does not pick
 * or pay for a model. Without `image`, send offers no image kind; without
 * `voiceMemo`, no voice_memo kind.
 */
export interface RelayMediaGenerators {
  image?(prompt: string, signal?: AbortSignal): Promise<RelayGeneratedImage>;
  voiceMemo?(text: string, style: string | undefined, signal?: AbortSignal): Promise<RelayGeneratedVoiceMemo>;
}

/** What the Actions run on, with every hook resolved. */
export interface RelayActionDependencies {
  env: RelayClientEnv;
  activities: RelayGenerationActivities;
  turn(): RelayTurnIdentity;
  signal(platformSignal?: AbortSignal): AbortSignal | undefined;
  assertCurrentTurn(identity: RelayTurnIdentity): void;
  setIrreversibleSend(active: boolean): void;
  waitUntil(task: Promise<void>): void;
  runChosenAction<T>(
    actionName: "send" | "react" | "stay_silent",
    operation: () => Promise<T>,
  ): Promise<T>;
  compose?: typeof finishComposition;
  /** The idempotency keys of the Messages a turn already sent, across its retries. */
  sentParts?: { has(key: string): boolean; add(key: string): void };
  timing?: (phase: RelayChatTimingPhase) => void;
  /** Whether this agent takes voice calls. When false, start_call is not offered. Absent means true. */
  voice?: boolean;
  media?: RelayMediaGenerators;
}

interface SentResult {
  status: "sent";
  kind: SendInput["kind"];
  messageId?: string;
  /** A payment request's id, for payment_request to read or cancel it later. */
  payment_request_id?: string;
}

/** A quote-reply asked for in a turn that answers no Message. */
export class RelayReplyRefused extends Error {
  override readonly name = "RelayReplyRefused";
  constructor() {
    super("This turn answers no Message, so there is nothing to reply to; send it without reply.");
  }
}

export interface VoiceTerminalResult {
  status: "terminal_ambiguous";
  kind: "voice_memo";
  result: "send_started_outcome_not_confirmed";
}

type SendResult = SentResult | VoiceTerminalResult;

async function sendCardAction(
  relay: Relay,
  identity: RelayTurnIdentity,
  input: Extract<SendInput, { kind: "rich_card" | "carousel" }>,
  signal?: AbortSignal,
): Promise<SentResult> {
  const card: MessagePart = input.kind === "rich_card"
    ? { type: "rich_card", ...cardContent(input.cards[0]!) }
    : {
      type: "carousel",
      ...(input.card_width === undefined ? {} : { card_width: input.card_width }),
      cards: input.cards.map(cardContent),
    };
  try {
    const result = await relay.chats.messages.send(identity.chatId, {
      message: {
        parts: input.text ? [{ type: "text", value: input.text }, card] : [card],
        idempotency_key: relayIdempotencyKey(identity.eventId),
      },
    }, requestOptions(signal));
    return { status: "sent", kind: input.kind, messageId: result.message.id };
  } catch (error) {
    // Relay's 400 names what it refused; the model fixes it and sends again.
    if (error instanceof RelayAPIError && error.status === 400) throw new RelayCardRefused(error.message);
    throw error;
  }
}

/** A generation the model gave no status for shows none. */
const NO_ACTIVITY = { stop: async () => {} };

function relayIdempotencyKey(eventId: string): string {
  return `relay-agent:${eventId}`;
}

function requestOptions(signal?: AbortSignal): RequestOptions {
  return signal ? { signal } : {};
}

async function finishComposition(
  text: string,
  eventId: string,
  startedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  const remaining = compositionDelayMs(text, eventId)
    - (Date.now() - startedAt);
  if (remaining > 0) await abortableDelay(remaining, signal);
}

function imageFilename(contentType: string, eventId: string): string {
  const extension = contentType === "image/jpeg"
    ? "jpg"
    : contentType === "image/webp"
    ? "webp"
    : "png";
  return `relay-${eventId}.${extension}`;
}

async function upload(
  relay: Relay,
  input: {
    bytes: Uint8Array;
    contentType: "audio/x-wav" | "image/jpeg" | "image/png" | "image/webp";
    filename: string;
    durationMs?: number;
  },
  signal?: AbortSignal,
): Promise<string> {
  const allocation = await relay.attachments.create({
    filename: input.filename,
    content_type: input.contentType,
    size_bytes: input.bytes.byteLength,
    ...(input.durationMs === undefined
      ? {}
      : { duration_ms: input.durationMs }),
  }, requestOptions(signal));
  await relay.attachments.upload(
    allocation,
    input.bytes.slice().buffer as ArrayBuffer,
    requestOptions(signal),
  );
  return allocation.attachment_id;
}

async function sendText(
  relay: Relay,
  identity: RelayTurnIdentity,
  input: Extract<SendInput, { kind: "text" }>,
  signal?: AbortSignal,
  timing?: (phase: RelayChatTimingPhase) => void,
): Promise<SentResult> {
  // A selection travels as an optional text part then the selection part with
  // its title; the schema has already refused it without title or beside buttons.
  if (input.reply && !identity.replyTo) throw new RelayReplyRefused();
  const parts: MessagePart[] = input.selection && input.title
    ? partsWithSelection(input.text, { type: "selection", title: input.title, options: input.selection })
    : [
      ...(input.text ? [{ type: "text" as const, value: input.text }] : []),
      ...(input.buttons
        ? [{
          type: "buttons" as const,
          items: input.buttons.map(({ label, url }) => ({ label, ...(url ? { url } : {}) })),
        }]
        : []),
    ];
  timing?.("post_sent");
  const result = await relay.chats.messages.send(identity.chatId, {
    message: {
      parts,
      idempotency_key: relayIdempotencyKey(identity.eventId),
      ...(input.reply && identity.replyTo
        ? { reply_to: { message_id: identity.replyTo.messageId, part_index: identity.replyTo.partIndex } }
        : {}),
      ...(input.silent ? { silent: true } : {}),
    },
  }, requestOptions(signal));
  timing?.("post_returned");
  return {
    status: "sent",
    kind: input.kind,
    messageId: result.message.id,
  };
}

async function sendPayment(
  relay: Relay,
  deps: RelayActionDependencies,
  identity: RelayTurnIdentity,
  input: Extract<SendInput, { kind: "payment" }>,
  signal?: AbortSignal,
): Promise<SentResult> {
  let request: PaymentRequest;
  try {
    request = await relay.paymentRequests.create({
      description: input.description,
      category: input.category,
      ...(input.mode === "subscription"
        ? { mode: "subscription" as const, price_id: input.price_id! }
        : { amount: input.amount!, currency: input.currency!.toLowerCase() }),
      ...(input.image_url ? { image_url: input.image_url } : {}),
      // Routes the request's payment.* events back to this Chat (webhook.ts).
      metadata: { [PAYMENT_CHAT_METADATA_KEY]: identity.chatId },
    }, {
      ...requestOptions(signal),
      idempotencyKey: `${relayIdempotencyKey(identity.eventId)}:payment_request`,
    });
  } catch (error) {
    if (error instanceof RelayAPIError && error.status === 403) {
      throw new RelayPaymentRefused(error.message);
    }
    throw error;
  }
  deps.assertCurrentTurn(identity);
  const result = await relay.chats.messages.send(identity.chatId, {
    message: {
      parts: [{ type: "payment", checkout_url: request.checkout_url }],
      idempotency_key: relayIdempotencyKey(identity.eventId),
    },
  }, requestOptions(signal));
  return {
    status: "sent",
    kind: input.kind,
    messageId: result.message.id,
    payment_request_id: request.id,
  };
}

/** A place pin, alone or after the model's words; it goes at once, like a link. */
async function sendPlace(
  relay: Relay,
  identity: RelayTurnIdentity,
  input: Extract<SendInput, { kind: "place" }>,
  signal?: AbortSignal,
): Promise<SentResult> {
  const result = await relay.chats.messages.send(identity.chatId, {
    message: {
      parts: [
        ...(input.text ? [{ type: "text" as const, value: input.text }] : []),
        {
          type: "place" as const,
          latitude: input.latitude,
          longitude: input.longitude,
          ...(input.name ? { name: input.name } : {}),
          ...(input.address ? { address: input.address } : {}),
        },
      ],
      idempotency_key: relayIdempotencyKey(identity.eventId),
    },
  }, requestOptions(signal));
  return { status: "sent", kind: input.kind, messageId: result.message.id };
}

export async function executeRelaySend(
  deps: RelayActionDependencies,
  input: SendInput,
  signal?: AbortSignal,
): Promise<SendResult> {
  const identity = deps.turn();
  deps.assertCurrentTurn(identity);
  const relay = createRelayClient(deps.env);
  const startedAt = identity.composingSince ?? Date.now();
  const compose = deps.compose ?? finishComposition;
  if (input.kind === "text") {
    // No words to type when the turn is only its buttons: the empty string
    // yields the floor pause rather than a typing time for text never sent.
    await compose(input.text ?? "", identity.eventId, startedAt, signal);
    deps.timing?.("compose_done");
    deps.assertCurrentTurn(identity);
    return await sendText(relay, identity, input, signal, deps.timing);
  }
  if (input.kind === "link") {
    const textKey = relayIdempotencyKey(identity.eventId);
    // A retried turn whose words already went sends only the link.
    if (input.text && !deps.sentParts?.has(textKey)) {
      await compose(input.text, identity.eventId, startedAt, signal);
      deps.assertCurrentTurn(identity);
      await relay.chats.messages.send(identity.chatId, {
        message: {
          parts: [{ type: "text", value: input.text }],
          idempotency_key: textKey,
        },
      }, requestOptions(signal));
      deps.sentParts?.add(textKey);
    }
    // The link travels alone, as the server requires; a person pastes a link
    // and it goes at once, so there is no composing pause before the card.
    const result = await relay.chats.messages.send(identity.chatId, {
      message: {
        parts: [{ type: "link", value: input.url }],
        idempotency_key: input.text
          ? `${relayIdempotencyKey(identity.eventId)}:link`
          : relayIdempotencyKey(identity.eventId),
      },
    }, requestOptions(signal));
    return { status: "sent", kind: input.kind, messageId: result.message.id };
  }
  if (input.kind === "payment") {
    // A payment is a card, not typed words; it goes at once, with no
    // composing pause, the same as a link.
    return await sendPayment(relay, deps, identity, input, signal);
  }
  if (input.kind === "place") {
    if (input.text) {
      await compose(input.text, identity.eventId, startedAt, signal);
      deps.assertCurrentTurn(identity);
    }
    return await sendPlace(relay, identity, input, signal);
  }
  if (input.kind === "rich_card" || input.kind === "carousel") {
    // A card, like a payment, goes at once.
    return await sendCardAction(relay, identity, input, signal);
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    deps.assertCurrentTurn(identity);
  };
  assertCurrent();
  // The status is the model's own words; without them nothing is shown.
  const activity = input.activity
    ? deps.activities.start(
      relay.chats,
      identity.chatId,
      { text: input.activity, emoji: input.activity_emoji ?? null },
      assertCurrent,
      (task) => deps.waitUntil(task),
    )
    : NO_ACTIVITY;
  // The voice Action settles before its non-idempotent send does. Only that
  // send's completion may take cleanup ownership away from this finally.
  let sendOwnsActivity = false;
  try {
    if (input.kind === "image") {
      if (!deps.media?.image) throw new Error("This agent has no image model");
      const image = await deps.media.image(input.prompt, signal);
      assertCurrent();
      const attachmentId = await upload(relay, {
        bytes: image.bytes,
        contentType: image.contentType,
        filename: imageFilename(image.contentType, identity.eventId),
      }, signal);
      await compose(
        input.caption ?? input.prompt,
        identity.eventId,
        startedAt,
        signal,
      );
      assertCurrent();
      const parts: MessagePart[] = [
        ...(input.caption
          ? [{ type: "text" as const, value: input.caption }]
          : []),
        { type: "media", attachment_id: attachmentId },
      ];
      const result = await relay.chats.messages.send(identity.chatId, {
        message: {
          parts,
          idempotency_key: relayIdempotencyKey(identity.eventId),
        },
      }, requestOptions(signal));
      return {
        status: "sent",
        kind: input.kind,
        messageId: result.message.id,
      };
    }
    if (!deps.media?.voiceMemo) throw new Error("This agent has no voice model");
    const voice = await deps.media.voiceMemo(input.text, input.style, signal);
    assertCurrent();
    const attachmentId = await upload(relay, {
      bytes: voice.bytes,
      contentType: voice.contentType,
      filename: `relay-${identity.eventId}.wav`,
      durationMs: voice.durationMs,
    }, signal);
    await compose(input.text, identity.eventId, startedAt, signal);
    assertCurrent();
    deps.setIrreversibleSend(true);
    const terminalResult: VoiceTerminalResult = {
      status: "terminal_ambiguous",
      kind: "voice_memo",
      result: "send_started_outcome_not_confirmed",
    };
    let send: Promise<ChatSendVoicememoResponse>;
    try {
      // Relay v1 has no idempotency key for this operation. Do not pass the
      // turn signal and do not let the SDK retry a timeout or network error.
      // Once this call returns a Promise, the Action must settle terminally.
      send = relay.chats.sendVoicememo(identity.chatId, {
        attachment_id: attachmentId,
      }, {
        maxRetries: 0,
        timeout: 15_000,
      });
    } catch (error) {
      // Preserve the same no-await terminal path even for a synchronous SDK
      // throw: activity cleanup must not make this Action retryable.
      send = Promise.reject(error);
    }
    const completion = send.then(
      () => logVoiceTerminal("confirmed_sent", identity),
      (error: unknown) => logVoiceTerminal("ambiguous", identity, error),
    ).finally(async () => {
      deps.setIrreversibleSend(false);
      await activity.stop();
    });
    sendOwnsActivity = true;
    // The current @cloudflare/think Action API races execute against
    // ActionContext.signal and releases the ledger row when that race throws.
    // Returning synchronously after dispatch lets Think settle the native
    // ledger before any timeout, disconnect, or later turn can make the
    // non-idempotent operation retryable. waitUntil only observes/logs the
    // eventual transport outcome and clears its generation activity.
    try {
      deps.waitUntil(completion);
    } catch (error) {
      // A waitUntil registration failure is itself ambiguous after dispatch,
      // but it must never escape and make Think release the Action ledger row.
      void completion;
      logVoiceTerminal("ambiguous", identity, error);
    }
    return terminalResult;
  } finally {
    if (!sendOwnsActivity) await activity.stop();
  }
}

export async function executeRelayReaction(
  deps: RelayActionDependencies,
  input: ReactionInput,
  signal?: AbortSignal,
): Promise<{ status: "reacted" | "unreacted"; type: ReactionInput["type"] }> {
  const current = deps.turn();
  deps.assertCurrentTurn(current);
  await createRelayClient(deps.env).messages.addReaction(
    current.reactTo?.messageId ?? current.eventId,
    {
      operation: input.remove ? "remove" : "add",
      type: input.type,
      ...(input.custom_emoji
        ? { custom_emoji: input.custom_emoji }
        : {}),
      ...(current.reactTo ? { part_index: current.reactTo.partIndex } : {}),
    },
    requestOptions(signal),
  );
  return { status: input.remove ? "unreacted" : "reacted", type: input.type };
}

function logVoiceTerminal(
  outcome: "confirmed_sent" | "ambiguous",
  identity: RelayTurnIdentity,
  error?: unknown,
): void {
  const status = (
    typeof error === "object"
    && error !== null
    && "status" in error
    && typeof error.status === "number"
  )
    ? error.status
    : undefined;
  console.warn(JSON.stringify({
    event: "relay_agent_voice_terminal",
    outcome,
    chat_id: identity.chatId,
    message_id: identity.eventId,
    ...(status === undefined ? {} : { http_status: status }),
    ...(error instanceof Error ? { error_type: error.name } : {}),
  }));
}

/** The name of every Action relayActions offers. */
export const RELAY_ACTION_NAMES = [
  "send",
  "react",
  "request_location",
  "read_location",
  "start_call",
  "find_agents",
  "payment_request",
  "group",
  "share_contact_card",
  "stay_silent",
] as const;
export type RelayActionName = (typeof RELAY_ACTION_NAMES)[number];

/**
 * A turn is one visible act. It goes on to another step only while every tool
 * the model just called gave it something to act on: a location read, a
 * location request, a call or a payment Relay refused with a reason (to tell
 * the person, or not), or a card Relay refused (its reason, to fix and send
 * again). A tool that is not a Relay Action is the agent's own, and its result
 * is something to act on.
 * Everything else ends the turn; a ringing call is the turn's act.
 */
export const relayTurnSettled: StopCondition<ToolSet> = ({ steps }) => {
  const step = steps.at(-1);
  if (!step || step.toolCalls.length === 0) return true;
  return !step.toolCalls.every((call) => {
    if (!RELAY_ACTIONS.has(call.toolName)) return true;
    // Reads give the model something to act on.
    if (CONTINUING_ACTIONS.has(call.toolName)) return true;
    const result = step.toolResults.find(({ toolCallId }) =>
      toolCallId === call.toolCallId
    );
    if (call.toolName === "send") {
      const refused = (result?.output as { error?: { name?: unknown } } | undefined)?.error?.name;
      return refused === "RelayCardRefused" || refused === "RelayPaymentRefused" || refused === "RelayReplyRefused";
    }
    const status = (result?.output as { status?: unknown } | undefined)?.status;
    if (call.toolName === "start_call") return status === "not_called";
    if (call.toolName === "group" || call.toolName === "share_contact_card") return status === "not_done";
    if (call.toolName !== "request_location") return false;
    return status === "not_requested";
  });
};

const RELAY_ACTIONS: ReadonlySet<string> = new Set(RELAY_ACTION_NAMES);

/** Actions whose result the model reads and acts on in the same turn. */
const CONTINUING_ACTIONS: ReadonlySet<string> = new Set([
  "read_location",
  "find_agents",
  "payment_request",
]);

export const RELAY_TURN_MAX_STEPS = 24;

/** Calls start now; scheduling a call later is the agent's own tool. */
const START_CALL_NOW_ONLY =
  "Call the person in this one-to-one chat now, by voice. Use it when "
  + "they ask you to call them, such as \"call me\" or \"can you call "
  + "me\". Their phone rings at once; when they answer, you talk with "
  + "them on the call. You cannot schedule a call for later. Returns "
  + "ringing when their phone is ringing, or not_called with the reason "
  + "Relay gave; then tell them that reason in the chat.";

/** The part of Think's messenger context a Relay turn is read from. */
export interface RelayMessengerContext {
  thread: { providerThreadId?: string };
  message?: { id?: string; providerMessageId?: string };
}

/** The agent relayActions reads: a Cloudflare Think agent passes itself. */
export interface RelayActionsAgent {
  /** RELAY_AGENT_TOKEN and RELAY_API_ORIGIN, from the agent's own Worker. */
  env: RelayClientEnv;
  /** Think's own; the default turn reads the Chat and Message from it. */
  getMessengerContext?(): RelayMessengerContext | undefined;
}

/** Everything optional: the hooks an agent overrides, and the Actions it leaves out. */
export interface RelayActionsOptions extends Partial<Omit<RelayActionDependencies, "env">> {
  /** Actions not to offer, by name. */
  disable?: readonly RelayActionName[];
}

/** The Chat and Message of the turn Think is running, from its messenger context. */
export function relayTurnFromMessenger(context: RelayMessengerContext | undefined): RelayTurnIdentity {
  const providerThreadId = context?.thread.providerThreadId;
  if (!providerThreadId) throw new Error("Relay messenger context is missing a Chat ID");
  const messageId = context.message?.providerMessageId ?? context.message?.id;
  if (!messageId) throw new Error("Relay messenger context is missing a Message ID");
  const { chatId } = decodeRelayThreadId(providerThreadId);
  return { chatId, eventId: messageId, replyTo: { messageId, partIndex: 0 } };
}

/**
 * Every Relay Action, for Think's getActions(). Spread the agent's own tools
 * beside them:
 *
 *     getActions() { return { ...relayActions(this), ...myTools }; }
 */
export function relayActions(
  agent: RelayActionsAgent,
  options: RelayActionsOptions = {},
): Record<string, Action> {
  const { disable = [], ...hooks } = options;
  const activities = hooks.activities ?? new RelayGenerationActivities();
  const deps: RelayActionDependencies = {
    signal: (platformSignal) => platformSignal,
    assertCurrentTurn: () => {},
    setIrreversibleSend: () => {},
    waitUntil: (task) => {
      void task.catch(() => {});
    },
    runChosenAction: (_actionName, operation) => operation(),
    ...hooks,
    env: agent.env,
    activities,
    turn: hooks.turn ?? (() => relayTurnFromMessenger(agent.getMessengerContext?.())),
  };
  const all = createRelayActions(deps);
  for (const name of disable) delete all[name];
  return all;
}

function createRelayActions(
  deps: RelayActionDependencies,
): Record<string, Action> {
  const sendKinds = RELAY_SEND_KINDS.filter((kind) =>
    (kind !== "image" || deps.media?.image !== undefined)
    && (kind !== "voice_memo" || deps.media?.voiceMemo !== undefined)
  );
  return {
    send: action({
      description:
        "Send one Relay Message. Use text for a normal Message"
        + (deps.media?.image ? ", image to generate and send one image or meme" : "")
        + (deps.media?.voiceMemo ? ", voice_memo to speak a real voice memo with an optional delivery style" : "")
        + ". Choose the content and wording yourself. Text is plain chat text, not Markdown. "
        + "Give buttons to draw up to five tappable buttons under the Message, "
        + "under the words when you send some and on their own when the whole "
        + "turn is the choice; see the buttons field for when to use them. Use "
        + "link to send a page as a "
        + "card the person looks at; see the url field for when. Use payment to "
        + "ask the person to pay, drawn as its own card with a Pay button. Use "
        + "rich_card to show one card with a picture, title, description and "
        + "suggestions, or carousel to show 2 to 10 of them side by side.",
      inputSchema: relaySendInputSchema(sendKinds),
      idempotencyKey: () => `message:${deps.turn().eventId}`,
      // Think 0.17 creates a framework timeout only when timeoutMs > 0.
      // Pre-dispatch generation/upload still obeys the turn signal and its own
      // bounded request timeouts. The irreversible voice call must not lose its
      // native Action ledger row to a framework timeout race.
      timeoutMs: 0,
      execute: (input, context) =>
        deps.runChosenAction(
          "send",
          () => executeRelaySend(
            deps,
            input,
            deps.signal(context.signal),
          ),
        ),
    }),
    react: action({
      description:
        "React to the current Relay Message instead of sending a Message. "
        + "After a person's reaction, the current Message is the one they "
        + "reacted to.",
      inputSchema: reactionInputSchema,
      idempotencyKey: () => `message:${deps.turn().eventId}`,
      execute: (input, context) =>
        deps.runChosenAction(
          "react",
          () => executeRelayReaction(deps, input, deps.signal(context.signal)),
        ),
    }),
    request_location: action({
      description:
        "Ask the person in this one-to-one chat to share their location. Relay "
        + "sends them a card with a Share My Location button, and they choose "
        + "how long to share. When they share, their location card comes back "
        + "to you as a Message.",
      inputSchema: z.object({}).strict(),
      idempotencyKey: () => `location_request:${deps.turn().eventId}`,
      execute: (_input, context) => {
        const identity = deps.turn();
        deps.assertCurrentTurn(identity);
        return requestRelayLocation(
          createRelayClient(deps.env),
          identity.chatId,
          requestOptions(deps.signal(context.signal)),
        );
      },
    }),
    read_location: action({
      description:
        "Read where the person sharing their location with you in this chat "
        + "is now: latitude, longitude, and when that position arrived. "
        + "Returns not_sharing when nobody is sharing.",
      inputSchema: z.object({}).strict(),
      execute: (_input, context) => {
        const identity = deps.turn();
        deps.assertCurrentTurn(identity);
        return readRelayLocation(
          createRelayClient(deps.env),
          identity.chatId,
          requestOptions(deps.signal(context.signal)),
        );
      },
    }),
    ...(deps.voice === false ? {} : {
      start_call: action({
        description: START_CALL_NOW_ONLY,
        inputSchema: z.object({}).strict(),
        idempotencyKey: () => `call:${deps.turn().eventId}`,
        execute: (_input, context) => {
          const identity = deps.turn();
          deps.assertCurrentTurn(identity);
          return startRelayCall(
            createRelayClient(deps.env),
            identity.chatId,
            relayCallIdempotencyKey(identity.eventId),
            requestOptions(deps.signal(context.signal)),
          );
        },
      }),
    }),
    find_agents: action({
      description:
        "Look up agents on Relay for the person: by task, the public agents that do it, verified first; or one "
        + "person or agent by handle. Returns each one's handle, name, and what it does, for you to tell the person.",
      inputSchema: findAgentsInputSchema,
      execute: (input, context) => {
        const identity = deps.turn();
        deps.assertCurrentTurn(identity);
        return findAgents(
          createRelayClient(deps.env),
          input,
          requestOptions(deps.signal(context.signal)),
        );
      },
    }),
    payment_request: action({
      description:
        "Read whether a payment request you sent was paid, or cancel it so it can no longer be paid. Name it by "
        + "the payment_request_id your payment send returned.",
      inputSchema: paymentRequestInputSchema,
      execute: (input, context) => {
        const identity = deps.turn();
        deps.assertCurrentTurn(identity);
        return executePaymentRequest(
          createRelayClient(deps.env),
          input,
          requestOptions(deps.signal(context.signal)),
        );
      },
    }),
    group: action({
      description:
        "Change this group chat when someone in it asks: rename it, set its photo, add an agent to it, remove a "
        + "member, or leave it. Returns done, or not_done with the reason Relay gave; then tell them that reason.",
      inputSchema: groupInputSchema,
      idempotencyKey: () => `group:${deps.turn().eventId}`,
      execute: (input, context) => {
        const identity = deps.turn();
        deps.assertCurrentTurn(identity);
        return changeGroup(
          createRelayClient(deps.env),
          identity.chatId,
          input,
          requestOptions(deps.signal(context.signal)),
        );
      },
    }),
    share_contact_card: action({
      description:
        "Share your own contact card into this chat, so people can add you or pass you on. Returns done, or "
        + "not_done with the reason Relay gave.",
      inputSchema: z.object({}).strict(),
      idempotencyKey: () => `contact_card:${deps.turn().eventId}`,
      execute: (_input, context) => {
        const identity = deps.turn();
        deps.assertCurrentTurn(identity);
        return shareContactCard(
          createRelayClient(deps.env),
          identity.chatId,
          requestOptions(deps.signal(context.signal)),
        );
      },
    }),
    stay_silent: action({
      description:
        "End this turn without sending anything when silence is the natural response.",
      inputSchema: z.object({}).strict(),
      idempotencyKey: () => `message:${deps.turn().eventId}`,
      execute: () =>
        deps.runChosenAction(
          "stay_silent",
          async () => ({ status: "silent" as const }),
        ),
    }),
  };
}
