import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import Relay, {
  WebhookVerificationError,
  verifyWebhookSignature,
  type ContactAddedWebhookEvent,
  type ContactRemovedWebhookEvent,
  type RelayWebhookEnvelope,
} from "../src/index.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(
    new URL(`./fixtures/${name}.json`, import.meta.url),
    "utf8",
  )) as T;

const signedHeaders = (
  secret: string,
  event: Pick<RelayWebhookEnvelope, "event_id" | "created_at">,
  body: string,
): Record<string, string> => {
  const timestamp = new Date();
  return {
    "webhook-id": event.event_id,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
    "webhook-signature": new Webhook(secret).sign(
      event.event_id,
      timestamp,
      body,
    ),
  };
};

describe("Standard Webhooks", () => {
  it("verifies and unwraps the raw Relay v1 envelope", () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const id = "01993d50-b4ce-71e6-8e65-35d325d95ddb";
    const timestamp = new Date();
    const event: RelayWebhookEnvelope = {
      api_version: "v1",
      webhook_version: "2026-08-30",
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
    const apiCalls: string[] = [];
    const client = new Relay({
      apiKey: "token",
      webhookSecret: secret,
      fetch: async (input) => {
        apiCalls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    expect(client.webhooks.unwrap(body, { headers })).toEqual(event);
    expect(apiCalls).toEqual([]);
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

  it("verifies and unwraps typed contact.added and contact.removed fixtures", () => {
    const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    const client = new Relay({
      apiKey: "token",
      webhookSecret: secret,
    });
    const added = fixture<ContactAddedWebhookEvent>("contact.added");
    const removed = fixture<ContactRemovedWebhookEvent>("contact.removed");

    const addedBody = JSON.stringify(added);
    const unwrappedAdded = client.webhooks.unwrap<ContactAddedWebhookEvent>(
      addedBody,
      { headers: signedHeaders(secret, added, addedBody) },
    );
    expect(unwrappedAdded.event_type).toBe("contact.added");
    expect(unwrappedAdded.data).toEqual({
      contact: {
        id: "01993d50-b4ce-71e6-8e65-35d325d95ddf",
        handle: "advait",
        display_name: "Advait",
      },
      chat_id: "01993d50-b4ce-71e6-8e65-35d325d95de0",
    });

    const removedBody = JSON.stringify(removed);
    const unwrappedRemoved = client.webhooks.unwrap<ContactRemovedWebhookEvent>(
      removedBody,
      { headers: signedHeaders(secret, removed, removedBody) },
    );
    expect(unwrappedRemoved.event_type).toBe("contact.removed");
    expect(unwrappedRemoved.data).toEqual({
      contact: {
        id: "01993d50-b4ce-71e6-8e65-35d325d95ddf",
        handle: "advait",
        display_name: "Advait",
      },
    });
    expect("chat_id" in unwrappedRemoved.data).toBe(false);
  });
});
