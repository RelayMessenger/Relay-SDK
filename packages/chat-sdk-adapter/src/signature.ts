import type { RelayCredential } from "./credentials.js";
import { resolveRelayCredential } from "./credentials.js";

export interface VerifyWebhookSignatureOptions {
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export class WebhookSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretError";
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new WebhookSecretError("value is not valid base64");
  }
  try {
    const binary = atob(normalized);
    if (!binary) throw new Error("empty");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new WebhookSecretError("value is not valid base64");
  }
}

export function decodeWebhookSecret(
  secret: string,
): Uint8Array<ArrayBuffer> {
  const encoded = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  try {
    return decodeBase64(encoded);
  } catch {
    throw new WebhookSecretError(
      "Relay webhookSecret must be the base64 whsec_ value Relay issued",
    );
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/**
 * Verify Relay's current Standard Webhooks v1 signature over the exact body.
 */
export async function verifyWebhookSignature(input: {
  headers: Pick<Headers, "get">;
  payload: string;
  secret: RelayCredential;
  options?: VerifyWebhookSignatureOptions;
}): Promise<void> {
  const id = input.headers.get("webhook-id");
  const timestamp = input.headers.get("webhook-timestamp");
  const signatures = input.headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) {
    throw new WebhookVerificationError(
      "missing Standard Webhooks signature headers",
    );
  }

  const parsedTimestamp = Number(timestamp);
  if (
    !Number.isSafeInteger(parsedTimestamp) ||
    parsedTimestamp < 0
  ) {
    throw new WebhookVerificationError("invalid webhook-timestamp");
  }
  const now =
    input.options?.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance =
    input.options?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    Math.abs(now - parsedTimestamp) > tolerance
  ) {
    throw new WebhookVerificationError(
      "webhook-timestamp outside tolerance",
    );
  }

  const secret = await resolveRelayCredential(
    input.secret,
    "Relay webhook signing secret",
  );
  const key = await crypto.subtle.importKey(
    "raw",
    decodeWebhookSecret(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const content = `${id}.${timestamp}.${input.payload}`;
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(content),
    ),
  );

  for (const candidate of signatures.split(/\s+/)) {
    const [version, encoded] = candidate.split(",", 2);
    if (version !== "v1" || !encoded) continue;
    let provided: Uint8Array;
    try {
      provided = decodeBase64(encoded);
    } catch {
      continue;
    }
    if (constantTimeEqual(expected, provided)) return;
  }
  throw new WebhookVerificationError("no matching v1 signature");
}
