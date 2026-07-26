import { RelayClient } from "./client.js";
import { verifyWebhookSignature, WebhookVerificationError } from "./signature.js";
import type {
  MessageReceivedEvent,
  RelayEventEnvelope,
  RelayOutgoingPart,
  SendResult,
  StreamSendResult,
  UIMessageStreamSource,
} from "./types.js";

export interface WebhookContext {
  event: MessageReceivedEvent;
  /** Convenience accessor for `event.data.message`. */
  message: MessageReceivedEvent["data"]["message"];
  /** Present only for group deliveries; already threaded into every reply helper. */
  invocationId?: string;
  client: RelayClient;
  /**
   * Reply helpers bound to the event's conversation and invocation. Each call
   * derives a deterministic Idempotency-Key from the event id and call order,
   * so a redelivered webhook replays instead of double-posting.
   */
  reply: {
    text(text: string): Promise<SendResult>;
    parts(parts: RelayOutgoingPart[]): Promise<SendResult>;
    stream(source: UIMessageStreamSource): Promise<StreamSendResult>;
  };
  typing(started?: boolean, label?: string): Promise<void>;
}

export type WebhookHandler = (context: WebhookContext) => Promise<void> | void;

export interface WebhookOptions {
  webhookSecret: string;
  client: RelayClient;
  /** message.received handler; other event types resolve 200 without dispatch. */
  onMessage: WebhookHandler;
  /** Background (`waitUntil`) and awaited handler failures land here. */
  onError?: (error: unknown, event?: RelayEventEnvelope) => void;
  /** Clock tolerance for signature verification, seconds. */
  toleranceSeconds?: number;
  /** In-memory event_id dedup window size. */
  dedupeWindow?: number;
}

const DEFAULT_DEDUPE_WINDOW = 4096;

class DedupeWindow {
  private readonly seen = new Set<string>();
  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * Record an id only after its event was durably handled. A failed handler
   * never records, so Relay's 5xx redelivery is dispatched again instead of
   * being swallowed by this window.
   */
  record(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a fetch-style webhook receiver: `(request) => Response`, usable
 * directly as a Next.js route handler, a Hono/Express-adapted handler, or in
 * any WinterCG runtime.
 *
 * Contract with Relay delivery (https://docs.relayapp.im/guides/webhooks):
 * verify the Standard Webhooks signature over the exact raw body, deduplicate
 * `event_id` (delivery is at least once), and return 2xx once the event is
 * durably handled. A thrown handler error returns 500 so Relay redelivers.
 */
export function createWebhookHandler(options: WebhookOptions) {
  const dedupe = new DedupeWindow(options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW);

  return async function handleWebhook(
    request: Request,
    context?: { waitUntil?: (promise: Promise<unknown>) => void },
  ): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, { error: { code: "method_not_allowed" } });
    }
    const payload = await request.text();
    try {
      await verifyWebhookSignature({
        secret: options.webhookSecret,
        payload,
        headers: {
          "webhook-id": request.headers.get("webhook-id"),
          "webhook-timestamp": request.headers.get("webhook-timestamp"),
          "webhook-signature": request.headers.get("webhook-signature"),
        },
        options: { toleranceSeconds: options.toleranceSeconds },
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return json(401, { error: { code: "invalid_signature", message: error.message } });
      }
      throw error;
    }

    let envelope: RelayEventEnvelope;
    try {
      envelope = JSON.parse(payload) as RelayEventEnvelope;
    } catch {
      return json(422, { error: { code: "invalid_request", message: "body is not JSON" } });
    }
    if (!envelope.event_id || !envelope.event_type) {
      return json(422, { error: { code: "invalid_request", message: "not an event envelope" } });
    }
    if (dedupe.has(envelope.event_id)) {
      return json(200, { deduplicated: true });
    }
    if (envelope.event_type !== "message.received") {
      // Unknown and future event types must never break the consumer.
      dedupe.record(envelope.event_id);
      return json(200, { ignored: envelope.event_type });
    }

    const event = envelope as MessageReceivedEvent;
    const invocationId = event.data.invocation_id;
    const conversationId = event.data.message.conversation_id;
    let sendSequence = 0;
    const nextKey = () => `${event.event_id}:${sendSequence++}`;
    const webhookContext: WebhookContext = {
      event,
      message: event.data.message,
      invocationId,
      client: options.client,
      reply: {
        text: (text) =>
          options.client.sendText({
            conversationId,
            text,
            invocationId,
            idempotencyKey: nextKey(),
          }),
        parts: (parts) =>
          options.client.send({
            conversationId,
            parts,
            invocationId,
            idempotencyKey: nextKey(),
          }),
        stream: (source) =>
          options.client.stream({
            conversationId,
            stream: source,
            invocationId,
            idempotencyKey: nextKey(),
          }),
      },
      typing: (started = true, label) =>
        options.client.typing({ conversationId, started, label, invocationId }),
    };

    if (context?.waitUntil) {
      context.waitUntil(
        Promise.resolve(options.onMessage(webhookContext)).then(
          () => dedupe.record(envelope.event_id),
          (error) => options.onError?.(error, envelope),
        ),
      );
      return json(202, { accepted: true });
    }

    try {
      await options.onMessage(webhookContext);
    } catch (error) {
      options.onError?.(error, envelope);
      return json(500, { error: { code: "handler_failed" } });
    }
    dedupe.record(envelope.event_id);
    return json(200, { handled: true });
  };
}
