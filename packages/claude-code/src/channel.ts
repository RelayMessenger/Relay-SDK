import { createHash } from "node:crypto";
import { RelayAPIError, ratingRequestPart, buttonsPart, createPaymentPart, formPart, indexedIdempotencyKey, paymentRequestFields, replyTargetContext, selectionPart, standaloneLink } from "@relaymessenger/sdk";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import Relay, { type Message, type MessagePart, type ReactionType, type RelayWebhookEvent, type ReplyTo } from "@relaymessenger/sdk";
import {
  buildReplyMessages,
  classifyRelayEvent,
  stableHash,
} from "./bridge.ts";
import type { RelayChannelConfig } from "./config.ts";
import { commitRelayFullSync } from "./fullSync.ts";
import type { Redactor } from "./redaction.ts";
import type { RelayStateStore } from "./state.ts";
import { MediaUploader, mediaInputs, type MediaInput } from "./media.ts";
import { carouselPart, placePart, richCardPart } from "./parts.ts";
import type { TurnOrigin } from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REACTION_TYPES: ReadonlySet<string> = new Set(["love", "like", "dislike", "laugh", "emphasize", "question", "custom"]);
/** Error code 1005 on a 409: the person already shares their location in this chat. */
const ALREADY_SHARING_CODE = 1005;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

function success(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class RelayChannel {
  readonly relay: Relay;
  readonly #mcp: Server;
  readonly #state: RelayStateStore;
  readonly #config: RelayChannelConfig;
  readonly #redactor: Redactor;
  readonly #log: (message: string) => void;
  readonly #abort = new AbortController();
  #flushPromise: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  readonly #media: MediaUploader;

  constructor(params: {
    readonly mcp: Server;
    readonly state: RelayStateStore;
    readonly config: RelayChannelConfig;
    readonly redactor: Redactor;
    readonly log: (message: string) => void;
    readonly relay?: Relay;
  }) {
    this.#mcp = params.mcp;
    this.#state = params.state;
    this.#config = params.config;
    this.#redactor = params.redactor;
    this.#log = params.log;
    // A lease left by a previous process is not something the model decided:
    // close it as interrupted so the unanswered delivery returns to the inbox
    // instead of being sealed as failed.
    this.#state.clearActiveTurn("interrupted");
    this.relay = params.relay ?? new Relay({
      apiKey: params.config.agentToken,
      baseURL: params.config.baseURL,
    });
    this.#media = new MediaUploader(this.relay);
  }

  async checkReady(): Promise<void> {
    const subscriptions = await this.relay.webhookSubscriptions.list();
    if (subscriptions.subscriptions.length > 0) {
      throw new Error(
        `Relay WebSocket delivery is unavailable while ${subscriptions.subscriptions.length} saved Webhook subscription(s) exist; remove them explicitly before starting this channel`,
      );
    }
  }

  async run(): Promise<void> {
    await this.checkReady();
    await this.flush();
    this.#timer = setInterval(() => {
      void this.flush().catch((error) => this.#log(`durable retry failed: ${this.#redactor.text(error)}`));
    }, 5_000);
    this.#timer.unref();
    this.#log(
      `connecting acknowledged Relay WebSocket at ${this.#config.baseURL}/v1/websocket; local checkpoint ${this.#state.acceptedThrough()}`,
    );
    await this.relay.websocket.run({
      signal: this.#abort.signal,
      onEvent: async (event: RelayWebhookEvent, context) => {
        this.#state.acceptEvent(event, context.sequence);
        queueMicrotask(() => {
          void this.flush().catch((error) =>
            this.#log(`durable ingress processing failed: ${this.#redactor.text(error)}`));
        });
      },
      onFullSync: async (context) => {
        this.#log(
          `Relay requested FULL sync through ${context.throughSequence} (${context.reason}); reconciling complete public REST state`,
        );
        await commitRelayFullSync({
          relay: this.relay,
          state: this.#state,
          context,
          allowedSenders: this.#config.allowedSenders,
          redactor: this.#redactor,
        });
        this.#log(`FULL sync durably committed through ${context.throughSequence}`);
        queueMicrotask(() => {
          void this.flush().catch((error) =>
            this.#log(`post-FULL-sync delivery failed: ${this.#redactor.text(error)}`));
        });
      },
      onError: (error) => this.#log(`Relay WebSocket: ${this.#redactor.text(error)}`),
    });
  }

  stop(): void {
    this.#state.clearActiveTurn("interrupted");
    this.#abort.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async flush(): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise;
    this.#flushPromise = this.#flushDurableWork().finally(() => {
      this.#flushPromise = null;
    });
    return this.#flushPromise;
  }

  async #flushDurableWork(): Promise<void> {
    this.#state.expireActiveTurn();
    await this.#processIngress();
    const retryBefore = Date.now() - this.#config.notificationRetryMs;
    for (const delivery of this.#state.pendingDeliveries(retryBefore)) {
      try {
        await this.#mcp.notification({
          method: "notifications/claude/channel",
          params: { content: delivery.content, meta: delivery.meta },
        });
        this.#state.noteDeliveryNotified(delivery.deliveryId);
      } catch (error) {
        this.#log(
          `channel notification ${delivery.deliveryId} failed; will retry: ${this.#redactor.text(error)}`,
        );
      }
    }
  }

  async #processIngress(): Promise<void> {
    for (;;) {
      const pending = this.#state.pendingIngress(100);
      if (pending.length === 0) return;
      for (const { event, sequence } of pending) {
        const action = classifyRelayEvent({
          event,
          sequence,
          allowedSenders: this.#config.allowedSenders,
          redactor: this.#redactor,
        });
        if (action.kind === "ignore") {
          this.#state.completeIngress(event.event_id);
          continue;
        }
        if (action.kind === "refuse") {
          throw new Error(
            `durable Relay Message ${event.event_id} requires operator review: ${action.reason}`,
          );
        }
        if (action.kind === "blocked") {
          this.#state.completeIngress(event.event_id, "blocked");
          this.#log(
            `dropped Relay Message from non-allowlisted sender ${this.#redactor.text(action.senderHandle)} (${action.senderId})`,
          );
          continue;
        }
        if (action.groupGate === "unaddressed") {
          this.#state.completeIngress(event.event_id);
          continue;
        }
        // A swipe-reply names the Message it answers, as Telegram hands a
        // bot `reply_to_message`. Relay sends only the pointer, so the target
        // is read once: for the group gate, and for Claude to read.
        const replyTo = replyPointer(event);
        let target: Message | undefined;
        if (replyTo) {
          try {
            target = await this.relay.messages.retrieve(replyTo.message_id);
          } catch (error) {
            // The group gate cannot decide without the target; the ingress
            // stays pending and is retried, as before.
            if (action.groupGate === "reply") throw error;
            this.#log(`could not read the Message a reply names; Claude sees its id: ${this.#redactor.text(error)}`);
          }
        }
        if (
          action.groupGate === "reply"
          && (!target || !targetsAgent(target, action.delivery.chatId, replyTo!.message_id))
        ) {
          this.#state.completeIngress(event.event_id);
          continue;
        }
        this.#state.recordDelivery(replyTo
          ? {
            ...action.delivery,
            content: [
              action.delivery.content,
              this.#redactor.text(replyTargetContext(replyTo, target)),
            ].filter(Boolean).join("\n\n"),
            meta: { reply_to: JSON.stringify(replyTo), ...action.delivery.meta },
          }
          : action.delivery);
      }
      if (pending.length < 100) return;
    }
  }

  async beginProcessing(argumentsValue: unknown): Promise<ToolResult> {
    const args = argumentsValue as { delivery_id?: unknown } | null;
    const deliveryId = args && typeof args.delivery_id === "string" ? args.delivery_id : "";
    if (!deliveryId || deliveryId.length > 255) {
      return failure("delivery_id must be copied exactly from the Relay <channel> tag");
    }
    const current = this.#state.delivery(deliveryId);
    if (!current) return failure(`delivery ${deliveryId} is not in the durable Relay inbox`);
    if (current.status === "processing") {
      try {
        this.#state.activateDeliveryOrigin(deliveryId);
      } catch (error) {
        return failure(this.#redactor.text(error));
      }
      return success(`processing already started for ${deliveryId}`);
    }
    const delivery = this.#state.beginDelivery(deliveryId);
    if (!delivery) return success(`processing already started for ${deliveryId}`);
    try {
      await this.relay.chats.markAsRead(delivery.chatId);
      this.#state.markDeliveryProcessing(deliveryId);
      return success(`processing started; Relay Chat ${delivery.chatId} marked Read`);
    } catch (error) {
      return failure(
        `could not mark the Relay Chat Read; do not process this delivery yet. Retry begin_processing. ${this.#redactor.text(error)}`,
      );
    }
  }

  async completeProcessing(argumentsValue: unknown): Promise<ToolResult> {
    const args = argumentsValue as {
      delivery_id?: unknown;
      outcome?: unknown;
    } | null;
    const deliveryId = args && typeof args.delivery_id === "string"
      ? args.delivery_id
      : "";
    const outcome = args?.outcome;
    if (!deliveryId || deliveryId.length > 255) {
      return failure("delivery_id must be copied exactly from the Relay <channel> tag");
    }
    if (outcome !== "completed" && outcome !== "failed") {
      return failure("outcome must be completed or failed");
    }
    const result = this.#state.completeDeliveryTurn(deliveryId, outcome);
    return success(
      result === "closed"
        ? `Relay turn ${deliveryId} ${outcome}; reply origin cleared`
        : `Relay turn ${deliveryId} was already closed`,
    );
  }

  async reply(argumentsValue: unknown): Promise<ToolResult> {
    const args = argumentsValue as {
      chat_id?: unknown;
      text?: unknown;
      send_id?: unknown;
      reply_to_message_id?: unknown;
      buttons?: unknown;
      selection?: unknown;
      form?: unknown;
      rating_request?: unknown;
      link?: unknown;
      payment?: unknown;
      media?: unknown;
      place?: unknown;
      rich_card?: unknown;
      carousel?: unknown;
    } | null;
    const chatId = args && typeof args.chat_id === "string" ? args.chat_id : "";
    if (args?.text !== undefined && typeof args.text !== "string") return failure("text must be a string");
    const text = args && typeof args.text === "string" ? args.text : "";
    const buttons = args?.buttons === undefined ? undefined : buttonsPart(args.buttons);
    if (typeof buttons === "string") return failure(`buttons: ${buttons}`);
    if (args?.link !== undefined && typeof args.link !== "string") return failure("link must be a string");
    const link = args && typeof args.link === "string" ? standaloneLink(args.link) : undefined;
    if (args?.link !== undefined && link === undefined) {
      return failure("link must be one absolute http or https URL of at most 2048 characters");
    }
    if (link !== undefined && buttons !== undefined) return failure("link and buttons do not go together; a page the person acts on is a url button");
    const selection = args?.selection === undefined ? undefined : selectionPart(args.selection);
    if (typeof selection === "string") return failure(`selection: ${selection}`);
    if (selection && (buttons || link)) return failure("selection cannot be combined with buttons or link");
    const payment = args?.payment === undefined ? undefined : paymentRequestFields(args.payment);
    if (typeof payment === "string") return failure(`payment: ${payment}`);
    if (payment && (buttons || selection)) return failure("a payment is a Message of its own; send it without buttons or selection");
    const form = args?.form === undefined ? undefined : formPart(args.form);
    if (typeof form === "string") return failure(`form: ${form}`);
    if (form && (buttons || link || selection || payment)) return failure("a form sits beside text only; send it without buttons, link, selection or payment");
    const media = args?.media === undefined ? undefined : mediaInputs(args.media);
    if (typeof media === "string") return failure(`media: ${media}`);
    const place = args?.place === undefined ? undefined : placePart(args.place);
    if (typeof place === "string") return failure(`place: ${place}`);
    const richCard = args?.rich_card === undefined ? undefined : richCardPart(args.rich_card);
    if (typeof richCard === "string") return failure(`rich_card: ${richCard}`);
    const carousel = args?.carousel === undefined ? undefined : carouselPart(args.carousel);
    if (typeof carousel === "string") return failure(`carousel: ${carousel}`);
    const card = richCard ?? carousel;
    if ([media, place, card].filter(Boolean).length > 1 || (richCard && carousel)) {
      return failure("send one of media, place, rich_card or carousel per reply");
    }
    if ((media || place || card) && (selection || form)) return failure("media, a place or a card do not go with a selection or form");
    if (place && buttons) return failure("a place sits beside text only; send it without buttons");
    if (args?.rating_request !== undefined && args.rating_request !== true) return failure("rating_request must be true");
    const ratingRequest = args?.rating_request === true ? ratingRequestPart() : undefined;
    if (ratingRequest && (text || buttons || link || selection || payment || form || media || place || card)) return failure("a rating request is the whole Message; send it alone");
    const sendId = args && typeof args.send_id === "string" ? args.send_id : "";
    const replyTo = args && typeof args.reply_to_message_id === "string"
      ? args.reply_to_message_id
      : undefined;
    if (!UUID_PATTERN.test(chatId)) return failure("chat_id must be a Relay Chat UUID from a channel tag");
    if (!SEND_ID_PATTERN.test(sendId)) {
      return failure("send_id must be 1-128 letters, digits, dot, underscore, colon, or hyphen");
    }
    if (replyTo !== undefined && !UUID_PATTERN.test(replyTo)) {
      return failure("reply_to_message_id must be a Relay Message UUID");
    }
    const redactedText = this.#redactor.text(text);
    // Known now: a place or a card. Media from a local file has its
    // attachment id only after the upload, so the plan and the hash carry
    // the model's own media arguments in its place.
    const known: MessagePart[] = [...(place ? [place] : []), ...(card ? [card] : [])];
    const plannedMedia = (media ?? []).map(mediaPlan);
    if ((!redactedText && !buttons && !link && !payment && !selection && !form && !ratingRequest && known.length === 0 && plannedMedia.length === 0) || redactedText.length > 10_000) {
      return failure("text must be 1-10000 UTF-16 code units after token redaction");
    }
    const idempotencyKey = `claude-reply-${createHash("sha256")
      .update(`${this.#config.accountKey}\0${this.#config.sessionKey}\0${sendId}`)
      .digest("hex")}`;
    // The words and link are known now; the payment card's checkout_url only
    // after Relay creates the request, so the hash covers the fields the
    // model gave, and the card sits on the key the last Message will carry.
    const plannedBodies = payment && !redactedText && !link && known.length === 0 && plannedMedia.length === 0
      ? []
      : buildReplyMessages(redactedText, idempotencyKey, replyTo, buttons, link, selection, undefined, form, ratingRequest, [...plannedMedia, ...known]);
    const body = plannedBodies[0];
    const payloadHash = stableHash(payment
      ? { chatId, bodies: plannedBodies, payment }
      : plannedBodies.length === 1 ? { chatId, body } : { chatId, bodies: plannedBodies });
    const existing = this.#state.existingOutboundSend({
      sendId,
      payloadHash,
      idempotencyKey,
    });
    if (existing?.confirmed) return success("already sent; Relay turn already completed");
    const origin = this.#state.activeTurnOrigin();
    if (!origin || origin.chatId !== chatId) {
      return failure("chat_id is not the authenticated origin of the active Relay turn");
    }
    if (replyTo !== undefined && replyTo !== origin.messageId) {
      return failure("reply_to_message_id is not the Message that originated the active Relay turn");
    }
    // A reply to another agent names its Message even when the model leaves
    // it out, as a bot's reply names the message it answers (Telegram
    // reply_parameters.message_id), so an agent with two messages open knows
    // which one this answers. A person's Message is named only when the model asks. The payload hash
    // stays on the model's own arguments, so a retry matches.
    const linked = replyTo ?? (origin.linksReply ? origin.messageId : undefined);
    let attached: MessagePart[] = known;
    if (media) {
      try {
        attached = [...await this.#media.parts(media, idempotencyKey), ...known];
      } catch (error) {
        return failure(`media upload failed: ${this.#redactor.text(error)}. Nothing was sent; retry with the same arguments, or fix the media and use a new send_id.`);
      }
    }
    let bodies = plannedBodies.length === 0
      ? plannedBodies
      : buildReplyMessages(redactedText, idempotencyKey, linked, buttons, link, selection, undefined, form, ratingRequest, attached);
    if (payment) {
      // Created before anything is sent, on the key its card will carry, so
      // a refusal reaches the model with nothing half-sent, and a retry of
      // this reply returns the same request.
      const cardKey = indexedIdempotencyKey(idempotencyKey, (redactedText || attached.length > 0 ? 1 : 0) + (link ? 1 : 0));
      try {
        const paymentCard = await createPaymentPart(this.relay, payment, cardKey);
        bodies = buildReplyMessages(redactedText, idempotencyKey, linked, buttons, link, selection, paymentCard, undefined, undefined, attached);
      } catch (error) {
        if (error instanceof RelayAPIError && !error.retryable) {
          return failure(`payment request refused: ${this.#redactor.text(error)}. Nothing was sent; fix the payment or reply without it, with a new send_id.`);
        }
        return failure(`payment request failed: ${this.#redactor.text(error)}. Retry with the same send_id, chat_id, text, link, payment, and reply_to_message_id.`);
      }
    }
    try {
      const registered = this.#state.registerOutboundSend({
        sendId,
        payloadHash,
        idempotencyKey,
      });
      if (registered.confirmed) {
        this.#state.completeDeliveryTurn(origin.deliveryId, "completed");
        return success("already sent; Relay turn completed");
      }
      // In order, each on its own key: a retry after a dropped connection
      // re-sends the whole reply, and Relay answers the already-sent ones
      // from their keys.
      for (const message of bodies) await this.relay.chats.messages.send(chatId, message);
      this.#state.confirmOutboundSend(sendId);
      this.#state.completeDeliveryTurn(origin.deliveryId, "completed");
      return success(
        redactedText === text
          ? "sent; Relay turn completed"
          : "sent with sensitive Relay token text redacted; Relay turn completed",
      );
    } catch (error) {
      return failure(
        form
          ? `send failed: ${this.#redactor.text(error)}. Retry with the same send_id, chat_id, text, form, and reply_to_message_id.`
          : selection
          ? `send failed: ${this.#redactor.text(error)}. Retry with the same send_id, chat_id, text, selection, and reply_to_message_id.`
          : payment
          ? `send failed: ${this.#redactor.text(error)}. Retry with the same send_id, chat_id, text, link, payment, and reply_to_message_id.`
          : `send failed: ${this.#redactor.text(error)}. Retry with the same send_id and the same arguments.`,
      );
    }
  }

  /**
   * The active turn's origin when chat_id names its Chat. Every tool below
   * acts only in that Chat, like reply.
   */
  #turnChat(argumentsValue: unknown): { origin: TurnOrigin; args: Record<string, unknown> } | ToolResult {
    const args = (argumentsValue !== null && typeof argumentsValue === "object" ? argumentsValue : {}) as Record<string, unknown>;
    const chatId = typeof args.chat_id === "string" ? args.chat_id : "";
    if (!UUID_PATTERN.test(chatId)) return failure("chat_id must be a Relay Chat UUID from a channel tag");
    const origin = this.#state.activeTurnOrigin();
    if (!origin || origin.chatId !== chatId) return failure("chat_id is not the authenticated origin of the active Relay turn");
    return { origin, args };
  }

  async typing(argumentsValue: unknown): Promise<ToolResult> {
    const turn = this.#turnChat(argumentsValue);
    if ("content" in turn) return turn;
    const action = turn.args.action;
    if (action !== "start" && action !== "stop") return failure("action must be start or stop");
    try {
      if (action === "start") await this.relay.chats.startTyping(turn.origin.chatId);
      else await this.relay.chats.stopTyping(turn.origin.chatId);
      return success(action === "start" ? "typing shown" : "typing cleared");
    } catch (error) {
      return failure(`typing failed: ${this.#redactor.text(error)}`);
    }
  }

  async react(argumentsValue: unknown): Promise<ToolResult> {
    const turn = this.#turnChat(argumentsValue);
    if ("content" in turn) return turn;
    const { args, origin } = turn;
    const messageId = args.message_id === undefined ? origin.messageId : args.message_id;
    if (typeof messageId !== "string" || !UUID_PATTERN.test(messageId)) return failure("message_id must be a Relay Message UUID");
    const type = args.type;
    if (typeof type !== "string" || !REACTION_TYPES.has(type)) {
      return failure("type must be love, like, dislike, laugh, emphasize, question or custom");
    }
    const emoji = args.custom_emoji;
    if ((type === "custom") !== (typeof emoji === "string" && emoji.trim().length > 0)) {
      return failure("custom_emoji goes with type custom, and only with it");
    }
    if (args.remove !== undefined && typeof args.remove !== "boolean") return failure("remove must be true or false");
    const partIndex = args.part_index;
    if (partIndex !== undefined && (!Number.isInteger(partIndex) || (partIndex as number) < 0)) {
      return failure("part_index must be a whole number from 0");
    }
    try {
      if (messageId !== origin.messageId) {
        // Only a Message in the turn's own Chat.
        const target = await this.relay.messages.retrieve(messageId);
        if (target.chat_id !== origin.chatId) return failure("message_id is not in the active Relay turn's Chat");
      }
      await this.relay.messages.addReaction(messageId, {
        operation: args.remove === true ? "remove" : "add",
        type: type as ReactionType,
        ...(type === "custom" ? { custom_emoji: (emoji as string).trim() } : {}),
        ...(partIndex !== undefined ? { part_index: partIndex as number } : {}),
      });
      return success(args.remove === true ? "reaction removed" : "reacted");
    } catch (error) {
      return failure(`reaction failed: ${this.#redactor.text(error)}`);
    }
  }

  async requestLocation(argumentsValue: unknown): Promise<ToolResult> {
    const turn = this.#turnChat(argumentsValue);
    if ("content" in turn) return turn;
    try {
      await this.relay.chats.location.request(turn.origin.chatId);
      return success("location request sent; the person's answer arrives as a Message");
    } catch (error) {
      if (error instanceof RelayAPIError && error.status === 409 && error.code === ALREADY_SHARING_CODE) {
        return success("not requested: the person already shares their location in this chat; use read_location");
      }
      if (error instanceof RelayAPIError && error.status === 429) {
        return failure(`not requested: a location request already went to this chat in the last 60 seconds${error.retryAfter === undefined ? "" : `; retry in ${error.retryAfter} seconds`}`);
      }
      return failure(`not requested: ${this.#redactor.text(error)}`);
    }
  }

  async readLocation(argumentsValue: unknown): Promise<ToolResult> {
    const turn = this.#turnChat(argumentsValue);
    if ("content" in turn) return turn;
    try {
      const { data } = await this.relay.chats.location.retrieve(turn.origin.chatId);
      if (data.features.length === 0) return success(JSON.stringify({ status: "not_sharing" }));
      // GeoJSON is longitude first; name the fields instead.
      return success(JSON.stringify({
        status: "sharing",
        locations: data.features.map(({ geometry, properties }) => ({
          handle: properties.handle,
          latitude: geometry.coordinates[1],
          longitude: geometry.coordinates[0],
          updated_at: properties.updated_at,
        })),
      }));
    } catch (error) {
      return failure(`location read failed: ${this.#redactor.text(error)}`);
    }
  }

  async shareContactCard(argumentsValue: unknown): Promise<ToolResult> {
    const turn = this.#turnChat(argumentsValue);
    if ("content" in turn) return turn;
    // One share per turn: a retry of the same turn replays on its key.
    const idempotencyKey = `claude-contact-card-${createHash("sha256")
      .update(`${this.#config.accountKey}\0${this.#config.sessionKey}\0${turn.origin.deliveryId}`)
      .digest("hex")}`;
    try {
      await this.relay.chats.shareContactCard(turn.origin.chatId, { idempotencyKey });
      return success("contact card shared");
    } catch (error) {
      return failure(`contact card not shared: ${this.#redactor.text(error)}`);
    }
  }
}

/**
 * A media argument in the reply's plan and payload hash. A local file's
 * attachment id is not known before the upload, so the plan names the path;
 * it is never sent.
 */
function mediaPlan(input: MediaInput): MessagePart {
  return (input.url !== undefined
    ? { type: "media", url: input.url }
    : { type: "media", path: input.path, ...(input.content_type ? { content_type: input.content_type } : {}) }) as MessagePart;
}

/** The `reply_to` pointer of an inbound Message, when it is a reply. */
function replyPointer(event: RelayWebhookEvent): ReplyTo | undefined {
  if (event.event_type !== "message.received") return undefined;
  const replyTo = (event.data as { reply_to?: ReplyTo | null }).reply_to;
  return typeof replyTo?.message_id === "string" ? replyTo : undefined;
}

/** Whether a group reply answers this agent's own Message in the same Chat. */
function targetsAgent(target: Message, chatId: string, messageId: string): boolean {
  return target.id === messageId
    && target.chat_id === chatId
    && target.is_from_me
    && !target.is_system_message;
}
