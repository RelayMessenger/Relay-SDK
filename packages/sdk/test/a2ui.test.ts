import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import Relay, {
  A2UI_BASIC_CATALOG_ID,
  A2UI_MEDIA_TYPE,
  RELAY_A2UI_CATALOG_ID,
  RelayAPIError,
  a2uiPart,
  deleteA2uiSurface,
  readA2uiAction,
  sendA2uiSurface,
  updateA2uiSurface,
  type A2uiComponent,
  type MessageSendResponse,
  type RelayWebhookEvent,
} from "../src/index.js";

// The card, update, tap and refusal below are the shapes Relay Server's own
// A2UI tests send and receive (Relay-Server PR 372 at f1200152,
// server/test/a2ui.test.ts: betCard, the "stream" update, action, "twice").
// test/fixtures/message.received.json is
// server/test/fixtures/webhooks/2026-08-30/message.received.json, byte for
// byte (unchanged from 738143df to f1200152).
const V = "v0.9.1";
const chatID = "00000000-0000-7000-8000-000000000023";
const betComponents: A2uiComponent[] = [
  { id: "root", component: "Card", child: "body" },
  { id: "body", component: "Column", children: ["title", "status", "bet"] },
  { id: "title", component: "Text", text: "Lakers win tonight?", variant: "h3" },
  { id: "status", component: "Text", text: { path: "/status" } },
  { id: "bet_icon", component: "Icon", name: "check" },
  { id: "bet", component: "Button", child: "bet_icon", variant: "primary",
    action: { event: { name: "place_bet", context: { side: "yes", stake: 50 } } } },
];
const betCard = (surfaceId: string) => [
  { version: V, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG_ID } },
  { version: V, updateComponents: { surfaceId, components: betComponents } },
  { version: V, updateDataModel: { surfaceId, value: { status: "Open" } } },
];

const cardMessage = {
  id: "00000000-0000-7000-8000-000000000025",
  parts: [{ type: "data" as const, media_type: A2UI_MEDIA_TYPE, data: betCard("bet-lakers"), reactions: null }],
  created_at: "2026-09-24T20:00:00.000Z",
  sent_at: "2026-09-24T20:00:00.000Z",
  delivery_status: "sent" as const,
  is_system_message: false as const,
};

const fixture = (): RelayWebhookEvent =>
  JSON.parse(readFileSync(new URL("./fixtures/message.received.json", import.meta.url), "utf8")) as RelayWebhookEvent;

function client(respond: () => Response) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const relay = new Relay({
    apiKey: "a2ui-test-token",
    baseURL: "https://api.staging.relayapp.im",
    retryBaseDelayMs: 0,
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init: init! });
      return respond();
    },
  });
  return { relay, requests };
}

const sentBody = (init: RequestInit) => JSON.parse(String(init.body)) as unknown;

describe("a2uiPart", () => {
  it("is A2A's DataPart with the A2UI media type", () => {
    expect(a2uiPart(betCard("x"))).toEqual({ type: "data", media_type: "application/a2ui+json", data: betCard("x") });
  });
});

describe("sendA2uiSurface", () => {
  it("sends createSurface, updateComponents and updateDataModel in one data part to the chat's messages", async () => {
    const response: MessageSendResponse = { chat_id: chatID, message: cardMessage };
    const { relay, requests } = client(() => Response.json(response, { status: 201 }));
    const result = await sendA2uiSurface(relay, chatID, {
      surfaceId: "bet-lakers",
      catalogId: A2UI_BASIC_CATALOG_ID,
      components: betComponents,
      dataModel: { status: "Open" },
    }, { idempotency_key: "bet-lakers-card" });
    expect(result).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.url.pathname).toBe(`/v1/chats/${chatID}/messages`);
    expect(new Headers(requests[0]!.init.headers).get("idempotency-key")).toBe("bet-lakers-card");
    expect(sentBody(requests[0]!.init)).toEqual({
      message: {
        idempotency_key: "bet-lakers-card",
        parts: [{ type: "data", media_type: "application/a2ui+json", data: betCard("bet-lakers") }],
      },
    });
  });

  it("puts text first, and carries theme and sendDataModel on createSurface; no dataModel sends no updateDataModel", async () => {
    const { relay, requests } = client(() => Response.json({ chat_id: chatID, message: cardMessage }, { status: 201 }));
    await sendA2uiSurface(relay, chatID, {
      surfaceId: "synced",
      catalogId: RELAY_A2UI_CATALOG_ID,
      components: betComponents,
      theme: { primaryColor: "#0B52C0" },
      sendDataModel: true,
    }, { text: "Place your bet", silent: true });
    expect(sentBody(requests[0]!.init)).toEqual({
      message: {
        silent: true,
        parts: [
          { type: "text", value: "Place your bet" },
          {
            type: "data",
            media_type: "application/a2ui+json",
            data: [
              { version: V, createSurface: { surfaceId: "synced", catalogId: RELAY_A2UI_CATALOG_ID, theme: { primaryColor: "#0B52C0" }, sendDataModel: true } },
              { version: V, updateComponents: { surfaceId: "synced", components: betComponents } },
            ],
          },
        ],
      },
    });
  });

  it("returns the A2UI messages Relay did not apply beside the Message", async () => {
    const a2ui_errors = [{
      part_index: 0,
      data_index: 1,
      a2ui_message: {
        version: "v0.9.1" as const,
        error: { code: "VALIDATION_FAILED" as const, surfaceId: "bet-lakers", path: "/components/0", message: "A component needs an id." },
      },
    }];
    const { relay } = client(() => Response.json({ a2ui_errors, chat_id: chatID, message: cardMessage }, { status: 201 }));
    const result = await sendA2uiSurface(relay, chatID, { surfaceId: "bet-lakers", catalogId: A2UI_BASIC_CATALOG_ID, components: betComponents });
    expect(result.a2ui_errors).toEqual(a2ui_errors);
  });

  it("throws the refusal with every A2UI error in the body when nothing was applied", async () => {
    // server/src/a2ui-send.ts at f1200152: a live surfaceId is a 409, error code 1005.
    const duplicate = "A surface with this surfaceId already exists in this chat; delete it before creating it again.";
    const body = {
      success: false,
      error: { status: 409, code: 1005, message: duplicate },
      a2ui_errors: [{
        part_index: 0,
        data_index: 0,
        a2ui_message: { version: V, error: { code: "VALIDATION_FAILED", surfaceId: "twice", path: "/surfaceId", message: duplicate } },
      }],
    };
    const { relay, requests } = client(() => Response.json(body, { status: 409 }));
    const refusal = await sendA2uiSurface(relay, chatID, { surfaceId: "twice", catalogId: A2UI_BASIC_CATALOG_ID, components: betComponents })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RelayAPIError);
    expect((refusal as RelayAPIError).status).toBe(409);
    expect(((refusal as RelayAPIError).body as typeof body).a2ui_errors).toEqual(body.a2ui_errors);
    expect(requests).toHaveLength(1);
  });
});

describe("updateA2uiSurface", () => {
  it("sends updateComponents then updateDataModel and returns the card's own Message", async () => {
    const response: MessageSendResponse = { chat_id: chatID, message: cardMessage };
    const { relay, requests } = client(() => Response.json(response));
    const result = await updateA2uiSurface(relay, chatID, "stream", {
      components: [{ id: "title", component: "Text", text: "Trade placed" }],
      dataModel: { path: "/status", value: "Placed" },
    });
    expect(result.message.id).toBe(cardMessage.id);
    expect(requests[0]!.url.pathname).toBe(`/v1/chats/${chatID}/messages`);
    expect(sentBody(requests[0]!.init)).toEqual({
      message: {
        parts: [{
          type: "data",
          media_type: "application/a2ui+json",
          data: [
            { version: V, updateComponents: { surfaceId: "stream", components: [{ id: "title", component: "Text", text: "Trade placed" }] } },
            { version: V, updateDataModel: { surfaceId: "stream", path: "/status", value: "Placed" } },
          ],
        }],
      },
    });
  });

  it("sends a data model change alone, with text and a reply target beside it", async () => {
    const { relay, requests } = client(() => Response.json({ chat_id: chatID, message: cardMessage }));
    await updateA2uiSurface(relay, chatID, "beside", { dataModel: { path: "/status", value: "Odds 2:1" } }, {
      text: "Odds moved",
      reply_to: { message_id: cardMessage.id, part_index: 0 },
    });
    expect(sentBody(requests[0]!.init)).toEqual({
      message: {
        reply_to: { message_id: cardMessage.id, part_index: 0 },
        parts: [
          { type: "text", value: "Odds moved" },
          { type: "data", media_type: "application/a2ui+json", data: [{ version: V, updateDataModel: { surfaceId: "beside", path: "/status", value: "Odds 2:1" } }] },
        ],
      },
    });
  });

  it("refuses an empty update without a request", () => {
    const { relay, requests } = client(() => Response.json({}));
    expect(() => updateA2uiSurface(relay, chatID, "stream", {})).toThrow("an update needs components or a dataModel");
    expect(requests).toHaveLength(0);
  });
});

describe("deleteA2uiSurface", () => {
  it("sends one deleteSurface", async () => {
    const { relay, requests } = client(() => Response.json({ chat_id: chatID, message: { ...cardMessage, parts: [] } }));
    await deleteA2uiSurface(relay, chatID, "gone");
    expect(sentBody(requests[0]!.init)).toEqual({
      message: { parts: [{ type: "data", media_type: "application/a2ui+json", data: [{ version: V, deleteSurface: { surfaceId: "gone" } }] }] },
    });
  });
});

describe("readA2uiAction", () => {
  it("reads the tap out of Relay Server's message.received fixture", () => {
    expect(readA2uiAction(fixture())).toEqual({
      action: {
        name: "place_bet",
        surfaceId: "bet-lakers",
        sourceComponentId: "bet",
        timestamp: "2026-09-24T20:00:00Z",
        context: { side: "yes", stake: 50 },
      },
    });
  });

  it("reads the same tap from a verified webhook and from the event's data", () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const relay = new Relay({ apiKey: "token", webhookSecret: secret });
    const event = fixture();
    const body = JSON.stringify(event);
    const timestamp = new Date();
    const unwrapped = relay.webhooks.unwrap(body, {
      headers: {
        "webhook-id": event.event_id,
        "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
        "webhook-signature": new Webhook(secret).sign(event.event_id, timestamp, body),
      },
    });
    expect(readA2uiAction(unwrapped)).toEqual(readA2uiAction(event));
    if (event.event_type !== "message.received") throw new Error("fixture is message.received");
    expect(readA2uiAction(event.data)).toEqual(readA2uiAction(event));
    expect(event.data.metadata?.a2uiClientCapabilities?.["v0.9"].supportedCatalogIds)
      .toEqual([RELAY_A2UI_CATALOG_ID, A2UI_BASIC_CATALOG_ID]);
  });

  it("returns the tapped surface's data model when the tap carries one", () => {
    const event = fixture();
    if (event.event_type !== "message.received") throw new Error("fixture is message.received");
    const surfaces = { "bet-lakers": { status: "Open", stake: 50 }, other: { status: "Closed" } };
    event.data.metadata = { ...event.data.metadata, a2uiClientDataModel: { version: V, surfaces } };
    expect(readA2uiAction(event)?.dataModel).toEqual({ status: "Open", stake: 50 });
  });

  it("returns null for another event type, a Message with no tap, and a data part with only an error", () => {
    const event = fixture();
    if (event.event_type !== "message.received") throw new Error("fixture is message.received");
    expect(readA2uiAction({ ...event, event_type: "message.sent" })).toBeNull();
    expect(readA2uiAction({ ...event.data, parts: event.data.parts.filter((part) => part.type === "text") })).toBeNull();
    expect(readA2uiAction({
      ...event.data,
      parts: [{
        type: "data",
        media_type: "application/a2ui+json",
        data: [{ version: V, error: { code: "VALIDATION_FAILED", surfaceId: "bet-lakers", path: "/components/0", message: "Could not draw it." } }],
        reactions: null,
      }],
    })).toBeNull();
  });
});
