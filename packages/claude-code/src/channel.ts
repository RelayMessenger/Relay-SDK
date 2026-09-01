import { createHash } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import Relay, { type RelayWebhookEvent } from "@relaymessenger/sdk";
import {
  buildReply,
  classifyRelayEvent,
  stableHash,
} from "./bridge.ts";
import type { RelayChannelConfig } from "./config.ts";
import { commitRelayFullSync } from "./fullSync.ts";
import type { Redactor } from "./redaction.ts";
import type { RelayStateStore } from "./state.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

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
    this.#state.clearActiveTurn("failed");
    this.relay = params.relay ?? new Relay({
      apiKey: params.config.agentToken,
      baseURL: params.config.baseURL,
    });
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
    this.#state.clearActiveTurn("failed");
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
        if (
          action.groupGate === "reply"
          && (
            !action.replyToMessageId
            || !await this.#replyTargetsAgent(
              action.delivery.chatId,
              action.replyToMessageId,
            )
          )
        ) {
          this.#state.completeIngress(event.event_id);
          continue;
        }
        this.#state.recordDelivery(action.delivery);
      }
      if (pending.length < 100) return;
    }
  }

  async #replyTargetsAgent(chatId: string, messageId: string): Promise<boolean> {
    const target = await this.relay.messages.retrieve(messageId);
    return target.id === messageId
      && target.chat_id === chatId
      && target.is_from_me
      && !target.is_system_message;
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
      this.#state.activateDeliveryOrigin(deliveryId);
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
    } | null;
    const chatId = args && typeof args.chat_id === "string" ? args.chat_id : "";
    const text = args && typeof args.text === "string" ? args.text : "";
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
    if (!redactedText || redactedText.length > 10_000) {
      return failure("text must be 1-10000 UTF-16 code units after token redaction");
    }
    const idempotencyKey = `claude-reply-${createHash("sha256")
      .update(`${this.#config.accountKey}\0${this.#config.sessionKey}\0${sendId}`)
      .digest("hex")}`;
    const body = buildReply(redactedText, idempotencyKey, replyTo);
    const payloadHash = stableHash({ chatId, body });
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
      await this.relay.chats.messages.send(chatId, body);
      this.#state.confirmOutboundSend(sendId);
      this.#state.completeDeliveryTurn(origin.deliveryId, "completed");
      return success(
        redactedText === text
          ? "sent; Relay turn completed"
          : "sent with sensitive Relay token text redacted; Relay turn completed",
      );
    } catch (error) {
      return failure(
        `send failed: ${this.#redactor.text(error)}. Retry with the same send_id, chat_id, text, and reply_to_message_id.`,
      );
    }
  }
}
