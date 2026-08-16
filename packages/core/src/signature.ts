import { WebhookVerificationError } from "./errors.js";

export type VerifyWebhookOptions = {
  toleranceSeconds?: number;
  nowSeconds?: number;
};

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return base64ToBytes(raw);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verify a Standard Webhooks signature as Relay signs deliveries:
 * HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw body}`.
 */
export async function verifyWebhookSignature(input: {
  secret: string;
  payload: string;
  headers: {
    "webhook-id": string | null | undefined;
    "webhook-timestamp": string | null | undefined;
    "webhook-signature": string | null | undefined;
  };
  options?: VerifyWebhookOptions;
}): Promise<void> {
  const id = input.headers["webhook-id"];
  const timestamp = input.headers["webhook-timestamp"];
  const signatureHeader = input.headers["webhook-signature"];
  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError("missing webhook signature headers");
  }

  const tolerance = input.options?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new WebhookVerificationError("invalid webhook-timestamp");
  }
  if (Math.abs(now - ts) > tolerance) {
    throw new WebhookVerificationError("webhook-timestamp outside tolerance");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    decodeSecret(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${id}.${timestamp}.${input.payload}`;
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent)),
  );

  for (const candidate of signatureHeader.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    let provided: Uint8Array;
    try {
      provided = base64ToBytes(value);
    } catch {
      continue;
    }
    if (constantTimeEqual(expected, provided)) return;
  }
  throw new WebhookVerificationError("no matching v1 signature");
}
