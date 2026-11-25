import {
  verifyWebhookSignature as verifySdkWebhookSignature,
  WebhookVerificationError as SdkWebhookVerificationError,
} from "@relaymessenger/sdk";
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

/**
 * Verify Relay's current Standard Webhooks v1 signature over the exact body,
 * delegating HMAC and timestamp verification to `@relaymessenger/sdk`.
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

  const secret = await resolveRelayCredential(
    input.secret,
    "Relay webhook signing secret",
  );
  // Validate the deployment secret before verification so malformed secrets
  // always surface as WebhookSecretError rather than a delivery 401.
  decodeWebhookSecret(secret);

  try {
    verifySdkWebhookSignature(secret, input.payload, input.headers, input.options);
  } catch (error) {
    if (error instanceof SdkWebhookVerificationError) {
      throw new WebhookVerificationError(error.message);
    }
    throw error;
  }
}
