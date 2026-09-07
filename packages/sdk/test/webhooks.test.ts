import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  WebhookVerificationError,
  verifyWebhookSignature,
  type ContactAddedWebhookEvent,
  type ContactRemovedWebhookEvent,
  type MessageEditedWebhook,
  type MessageFailedWebhook,
  type MessageUnsentWebhook,
  type RelayWebhookEnvelope,
  type RelayWebhookEvent,
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

const chat = {
  id: "01993d50-b4ce-71e6-8e65-35d325d95de0",
  is_group: false,
  owner_handle: null,
};
const senderHandle = {
  id: "01993d50-b4ce-71e6-8e65-35d325d95ddf",
  handle: "echo",
  joined_at: "2026-09-03T00:00:00.000Z",
  kind: "agent" as const,
  display_name: "Echo",
  image_url: null,
  about: null,
  verified: true,
};

const envelope = <T>(
  eventType: RelayWebhookEvent["event_type"],
  data: T,
): RelayWebhookEnvelope<T> => ({
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: eventType,
  event_id: "01993d50-b4ce-71e6-8e65-35d325d95ddb",
  created_at: "2026-09-03T00:00:01.000Z",
  trace_id: "trace",
  agent_id: "01993d50-b4ce-71e6-8e65-35d325d95dde",
  data,
});

const editedData = {
  chat,
  direction: "inbound" as const,
  edited_at: "2026-09-03T00:00:01.000Z",
  id: "01993d50-b4ce-71e6-8e65-35d325d95dd0",
  part: { index: 1, text: "Corrected" },
  sender_handle: senderHandle,
};
const unsentData = {
  chat,
  direction: "inbound" as const,
  id: "01993d50-b4ce-71e6-8e65-35d325d95dd0",
  sender_handle: senderHandle,
  unsent_at: "2026-09-03T00:00:02.000Z",
};
const failedData = {
  chat_id: chat.id,
  message_id: "01993d50-b4ce-71e6-8e65-35d325d95dd0",
  // The code and shape the Server actually enqueues (server/src/webhooks.ts).
  code: 3006,
  reason: "Webhook delivery went terminal.",
  detail_code: 410,
  failed_at: "2026-09-03T00:00:03.000Z",
};

describe("Message change events", () => {
  const secret = `whsec_${Buffer.alloc(32, 11).toString("base64")}`;
  const client = new Relay({ apiKey: "token", webhookSecret: secret });
  const unwrap = <T extends RelayWebhookEvent>(event: T): T => {
    const raw = JSON.stringify(event);
    return client.webhooks.unwrap<T>(raw, {
      headers: signedHeaders(secret, event, raw),
    });
  };

  it("parses and narrows message.edited", () => {
    const event = unwrap(
      envelope("message.edited", editedData) as MessageEditedWebhook,
    );
    expect(event.event_type).toBe("message.edited");
    if (event.event_type !== "message.edited") throw new Error("not narrowed");
    expect(event.data.part).toEqual({ index: 1, text: "Corrected" });
    expect(event.data.edited_at).toBe("2026-09-03T00:00:01.000Z");
    expect(event.data.direction).toBe("inbound");
    expect(event.data.sender_handle?.handle).toBe("echo");
    expect(event.data.chat.id).toBe(chat.id);
  });

  it("parses and narrows message.unsent as message.edited without part", () => {
    const event = unwrap(
      envelope("message.unsent", unsentData) as MessageUnsentWebhook,
    );
    expect(event.event_type).toBe("message.unsent");
    if (event.event_type !== "message.unsent") throw new Error("not narrowed");
    expect(event.data.unsent_at).toBe("2026-09-03T00:00:02.000Z");
    expect("part" in event.data).toBe(false);
    expect("edited_at" in event.data).toBe(false);
    // The server writes the unsend payload as the edit payload minus `part`,
    // with `unsent_at` where the edit carries `edited_at`.
    expect(Object.keys(event.data).sort()).toEqual(
      [
        ...Object.keys(editedData).filter((key) =>
          key !== "part" && key !== "edited_at"
        ),
        "unsent_at",
      ].sort(),
    );
  });

  it("parses and narrows message.failed", () => {
    const event = unwrap(
      envelope("message.failed", failedData) as MessageFailedWebhook,
    );
    expect(event.event_type).toBe("message.failed");
    if (event.event_type !== "message.failed") throw new Error("not narrowed");
    expect(event.data.code).toBe(3006);
    expect(event.data.detail_code).toBe(410);
    expect(event.data.failed_at).toBe("2026-09-03T00:00:03.000Z");
    expect(event.data.message_id).toBe(failedData.message_id);
  });

  it("publishes exactly the event types the carried contract declares", () => {
    // A future Relay Server event reaches this repository through the carried
    // OpenAPI first. Set equality keeps it failing here until the SDK adds the
    // type, rather than silently arriving as an unstructured payload.
    const contract = readFileSync(
      new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url),
      "utf8",
    );
    const block = contract.slice(
      contract.indexOf("\n    WebhookEventType:\n"),
    );
    const lines = block
      .slice(block.indexOf("\n      enum:\n"))
      .split("\n")
      .slice(2);
    const end = lines.findIndex((line) => !line.startsWith("        - "));
    const enumerated = lines
      .slice(0, end === -1 ? lines.length : end)
      .map((line) => line.slice("        - ".length));

    expect(enumerated.length).toBeGreaterThan(0);
    expect([...RELAY_WEBHOOK_EVENT_TYPES].sort())
      .toEqual([...enumerated].sort());
  });
});
