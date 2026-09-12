import {
  Webhook,
  WebhookVerificationError,
} from "standardwebhooks";
import type {
  RelayWebhookEnvelope,
  RelayWebhookEvent,
} from "./types.js";

export { WebhookVerificationError };

export type WebhookHeaders =
  | Headers
  | Record<string, string | null | undefined>;

const requiredHeaders = (
  headers: WebhookHeaders,
): Record<string, string> => {
  const get = (name: string): string | null | undefined =>
    headers instanceof Headers ? headers.get(name) : headers[name];
  const id = get("webhook-id");
  const timestamp = get("webhook-timestamp");
  const signature = get("webhook-signature");
  if (!id || !timestamp || !signature) {
    throw new WebhookVerificationError(
      "Missing webhook-id, webhook-timestamp, or webhook-signature.",
    );
  }
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  };
};

/** The three Standard Webhooks headers for one delivery: `webhook-id`,
 * `webhook-timestamp` (unix seconds) and `webhook-signature` (`v1,<base64
 * HMAC-SHA256 over id.timestamp.body>`), signed with a `whsec_` secret. Relay
 * signs deliveries this way, and the CLI's local `listen` forwards sign the
 * same way, so one receiver verifies both with `verifyWebhookSignature`. */
export const signWebhookHeaders = (
  secret: string,
  delivery: { id: string; body: string | Buffer; timestamp?: Date },
): Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string> => {
  const timestamp = delivery.timestamp ?? new Date();
  return {
    "webhook-id": delivery.id,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
    "webhook-signature": new Webhook(secret).sign(delivery.id, timestamp, delivery.body),
  };
};

export const verifyWebhookSignature = (
  secret: string,
  body: string | Buffer,
  headers: WebhookHeaders,
): void => {
  new Webhook(secret).verify(body, requiredHeaders(headers));
};

export class Webhooks {
  readonly #secret: string | null;

  constructor(secret: string | null) {
    this.#secret = secret;
  }

  verify(
    body: string | Buffer,
    { headers, key }: { headers: WebhookHeaders; key?: string },
  ): void {
    const secret = key ?? this.#secret;
    if (!secret) throw new Error("Webhook key is required.");
    verifyWebhookSignature(secret, body, headers);
  }

  unwrap<T = RelayWebhookEvent>(
    body: string | Buffer,
    params: { headers: WebhookHeaders; key?: string },
  ): T {
    this.verify(body, params);
    return JSON.parse(body.toString()) as T;
  }
}

export type { RelayWebhookEnvelope };
