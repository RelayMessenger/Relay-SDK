import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WebhookVerificationError } from "./signature.js";

const SECRET_BYTES = Buffer.from("test-secret-key-material");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function sign(id: string, timestamp: string, payload: string): string {
  const mac = createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return `v1,${mac}`;
}

const NOW = 1_753_500_000;

describe("verifyWebhookSignature", () => {
  const payload = JSON.stringify({ event_id: "evt_1", event_type: "message.received" });

  it("accepts a valid v1 signature", async () => {
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        payload,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": String(NOW),
          "webhook-signature": sign("msg_1", String(NOW), payload),
        },
        options: { nowSeconds: NOW },
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts when a valid signature is one of several candidates", async () => {
    const good = sign("msg_1", String(NOW), payload);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        payload,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": String(NOW),
          "webhook-signature": `v1,${Buffer.from("nope").toString("base64")} ${good}`,
        },
        options: { nowSeconds: NOW },
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts the secret without the whsec_ prefix", async () => {
    await expect(
      verifyWebhookSignature({
        secret: SECRET_BYTES.toString("base64"),
        payload,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": String(NOW),
          "webhook-signature": sign("msg_1", String(NOW), payload),
        },
        options: { nowSeconds: NOW },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a tampered payload", async () => {
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        payload: payload + "x",
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": String(NOW),
          "webhook-signature": sign("msg_1", String(NOW), payload),
        },
        options: { nowSeconds: NOW },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects a future-skewed timestamp", async () => {
    const future = String(NOW + 6 * 60);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        payload,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": future,
          "webhook-signature": sign("msg_1", future, payload),
        },
        options: { nowSeconds: NOW },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects a stale timestamp", async () => {
    const old = String(NOW - 6 * 60);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        payload,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": old,
          "webhook-signature": sign("msg_1", old, payload),
        },
        options: { nowSeconds: NOW },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects missing headers", async () => {
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        payload,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": String(NOW),
          "webhook-signature": undefined,
        },
        options: { nowSeconds: NOW },
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
