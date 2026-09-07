import { describe, expect, it } from "vitest";
import {
  decodeWebhookSecret,
  verifyWebhookSignature,
  WebhookSecretError,
  WebhookVerificationError,
} from "../src/index.js";
import {
  envelope,
  signedRequest,
  WEBHOOK_SECRET,
} from "./helpers.js";

describe("Relay Standard Webhooks v1 signatures", () => {
  it("accepts the exact signed raw body", async () => {
    const request = await signedRequest(envelope());
    await expect(
      verifyWebhookSignature({
        headers: request.headers,
        payload: await request.text(),
        secret: WEBHOOK_SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a valid candidate during signature rotation", async () => {
    const request = await signedRequest(envelope());
    const body = await request.text();
    const headers = new Headers(request.headers);
    headers.set(
      "webhook-signature",
      `v1,AAAA ${headers.get("webhook-signature")}`,
    );
    await expect(
      verifyWebhookSignature({
        headers,
        payload: body,
        secret: WEBHOOK_SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects tampering, missing headers, and stale timestamps", async () => {
    const request = await signedRequest(envelope());
    await expect(
      verifyWebhookSignature({
        headers: request.headers,
        payload: `${await request.text()} `,
        secret: WEBHOOK_SECRET,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);

    await expect(
      verifyWebhookSignature({
        headers: new Headers(),
        payload: "{}",
        secret: WEBHOOK_SECRET,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);

    const old = await signedRequest(envelope(), {
      timestamp: Math.floor(Date.now() / 1_000) - 301,
    });
    await expect(
      verifyWebhookSignature({
        headers: old.headers,
        payload: await old.text(),
        secret: WEBHOOK_SECRET,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("names malformed deployment secrets separately", () => {
    expect(() => decodeWebhookSecret("whsec_!!!")).toThrow(
      WebhookSecretError,
    );
  });
});
