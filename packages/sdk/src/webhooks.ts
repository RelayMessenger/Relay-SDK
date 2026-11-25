import {
  Webhook,
  WebhookVerificationError,
} from "standardwebhooks";
import type {
  RelayWebhookEnvelope,
  RelayWebhookEvent,
} from "./types.js";

export { WebhookVerificationError };

export interface VerifyWebhookSignatureOptions {
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export type WebhookHeaders =
  | Pick<Headers, "get">
  | Record<string, string | null | undefined>;

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

const isHeadersLike = (
  headers: WebhookHeaders,
): headers is Pick<Headers, "get"> =>
  typeof (headers as Pick<Headers, "get">).get === "function";

const requiredHeaders = (
  headers: WebhookHeaders,
): Record<string, string> => {
  let get: (name: string) => string | null | undefined;
  if (isHeadersLike(headers)) {
    get = (name) => headers.get(name);
  } else {
    const normalized = new Map<string, string | null | undefined>();
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (value != null && (!normalized.has(lower) || normalized.get(lower) == null)) {
        normalized.set(lower, value);
      }
    }
    get = (name) => normalized.get(name);
  }
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

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
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
  options?: VerifyWebhookSignatureOptions,
): void => {
  const required = requiredHeaders(headers);
  const id = required["webhook-id"]!;
  const timestamp = required["webhook-timestamp"]!;
  const signatures = required["webhook-signature"]!;

  const parsedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(parsedTimestamp) || parsedTimestamp < 0) {
    throw new WebhookVerificationError("Invalid webhook-timestamp.");
  }
  const now = options?.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = options?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (
    !Number.isFinite(tolerance)
    || tolerance < 0
    || Math.abs(now - parsedTimestamp) > tolerance
  ) {
    throw new WebhookVerificationError("webhook-timestamp outside tolerance.");
  }

  const computed = new Webhook(secret).sign(
    id,
    new Date(parsedTimestamp * 1_000),
    body,
  );
  const expected = new TextEncoder().encode(computed.split(",", 2)[1] ?? "");
  const encoder = new TextEncoder();
  for (const candidate of signatures.split(/\s+/u)) {
    const [version, encoded] = candidate.split(",", 2);
    if (version !== "v1" || !encoded) continue;
    if (constantTimeEqual(encoder.encode(encoded), expected)) return;
  }
  throw new WebhookVerificationError("No matching v1 signature found.");
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
