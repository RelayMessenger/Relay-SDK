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
