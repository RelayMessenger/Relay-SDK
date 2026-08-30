import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import Relay, {
  WebhookVerificationError,
  verifyWebhookSignature,
  type RelayWebhookEnvelope,
} from "../src/index.js";

describe("Standard Webhooks", () => {
  it("verifies and unwraps the raw Relay v1 envelope", () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const id = "01993d50-b4ce-71e6-8e65-35d325d95ddb";
    const timestamp = new Date();
    const event: RelayWebhookEnvelope = {
      api_version: "v1",
      webhook_version: "2026-02-03",
      event_type: "message.received",
      event_id: id,
      created_at: timestamp.toISOString(),
      trace_id: "trace",
      agent_id: "01993d50-b4ce-71e6-8e65-35d325d95dde",
      data: { id: "message" },
    };
    const body = JSON.stringify(event);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "webhook-signature": new Webhook(secret).sign(id, timestamp, body),
    };
    verifyWebhookSignature(secret, body, headers);
    const client = new Relay({
      apiKey: "token",
      webhookSecret: secret,
    });
    expect(client.webhooks.unwrap(body, { headers })).toEqual(event);
  });

  it("rejects a changed body", () => {
    const secret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
    const id = "01993d50-b4ce-71e6-8e65-35d325d95ddb";
    const now = new Date();
    const body = '{"api_version":"v1"}';
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1_000)),
      "webhook-signature": new Webhook(secret).sign(id, now, body),
    };
    expect(() =>
      verifyWebhookSignature(secret, `${body} `, headers)
    ).toThrow(WebhookVerificationError);
  });
});
