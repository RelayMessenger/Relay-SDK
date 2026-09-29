import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  RelayAPIError,
  type GetChatLocationResponse,
  type LocationRequestResponse,
  type LocationSharingStartedWebhookEvent,
  type LocationSharingStoppedWebhookEvent,
  type Message,
  type RelayWebhookEvent,
} from "../src/index.js";

// Bodies captured from the Relay Server location-sharing branch on 2026-09-23
// (_artifacts/location-sharing-20260923/WIRE.md in the Relay hub).
const requested: LocationRequestResponse = { success: true, message: "Location request sent" };
const sharing: GetChatLocationResponse = {
  success: true,
  data: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [-122.4194, 37.7749] },
      properties: { handle: "alice", updated_at: "2026-09-23T17:44:45.947Z" },
    }],
  },
};
const chatID = "01a0cf5d-9f46-75fb-a7be-d7b7c46bd258";

function fixture(respond: () => Response) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const client = new Relay({
    apiKey: "location-test-token",
    baseURL: "https://api.staging.relayapp.im",
    retryBaseDelayMs: 0,
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init: init! });
      return respond();
    },
  });
  return { client, requests };
}

const contract = readFileSync(
  new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url),
  "utf8",
);
/** The text of one components.schemas entry in the carried contract. */
const schema = (name: string): string => {
  const start = contract.indexOf(`\n    ${name}:\n`);
  expect(start).toBeGreaterThan(0);
  const rest = contract.slice(start + 1);
  const next = rest.slice(1).search(/\n    [A-Za-z]+:\n/u);
  return rest.slice(0, next + 1);
};

describe("chats.location", () => {
  it("requests with a bodiless POST to the contract's requestLocation path", async () => {
    const { client, requests } = fixture(() => Response.json(requested));
    expect(await client.chats.location.request(chatID)).toEqual(requested);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.url.pathname).toBe(`/v1/chats/${chatID}/location/request`);
    expect(requests[0]!.init.body).toBeUndefined();
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer location-test-token");
    expect(contract).toContain("  /v1/chats/{chatId}/location/request:\n    post:\n      operationId: requestLocation\n");
  });

  it("reads the FeatureCollection, longitude first, from the contract's getLocation path", async () => {
    const { client, requests } = fixture(() => Response.json(sharing));
    const read = await client.chats.location.retrieve("chat/one");
    expect(read).toEqual(sharing);
    const [longitude, latitude] = read.data.features[0]!.geometry.coordinates;
    expect({ longitude, latitude }).toEqual({ longitude: -122.4194, latitude: 37.7749 });
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.url.pathname).toBe("/v1/chats/chat%2Fone/location");
    expect(contract).toContain("  /v1/chats/{chatId}/location:\n    get:\n      operationId: getLocation\n");
    expect(schema("LocationFeature")).toContain("required: [type, geometry, properties]");
    expect(schema("LocationFeature")).toContain('description: "[longitude, latitude]"');
  });

  it("reads an empty collection when nobody is sharing", async () => {
    const empty: GetChatLocationResponse = { success: true, data: { type: "FeatureCollection", features: [] } };
    const { client } = fixture(() => Response.json(empty));
    expect((await client.chats.location.retrieve(chatID)).data.features).toEqual([]);
  });

  it("never retries a request: a 429 surfaces once with Retry-After", async () => {
    const { client, requests } = fixture(() => Response.json({
      error: {
        status: 429,
        code: 2008,
        message: "Too many location requests in this chat. Try again shortly.",
        doc_url: "https://docs.relayapp.im/error/codes/2xxx/2008",
        retry_after: 60,
      },
      success: false,
      trace_id: "0a76ee4c4a1e4807a12e24965501bf64",
    }, { status: 429, headers: { "Retry-After": "60" } }));
    const error = await client.chats.location.request(chatID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayAPIError);
    expect(error).toMatchObject({ status: 429, code: 2008, retryAfter: 60 });
    expect(requests).toHaveLength(1);
  });

  it("surfaces the group-chat 409 with its code", async () => {
    const { client } = fixture(() => Response.json({
      error: { status: 409, code: 2016, message: "Location sharing is not supported in group chats." },
      success: false,
    }, { status: 409 }));
    await expect(client.chats.location.request(chatID)).rejects.toMatchObject({ status: 409, code: 2016 });
  });
});

describe("location webhooks and parts", () => {
  it("carries both events in the SDK list and the contract enum", () => {
    expect(RELAY_WEBHOOK_EVENT_TYPES).toContain("location.sharing.started");
    expect(RELAY_WEBHOOK_EVENT_TYPES).toContain("location.sharing.stopped");
    expect(schema("LocationSharingStartedEvent"))
      .toContain("required: [shared_by, shared_with, chat_id, began_at, ends_at]");
    expect(schema("LocationSharingStoppedEvent"))
      .toContain("required: [shared_by, shared_with, chat_id, began_at, ended_at]");
  });

  it("narrows the captured events by event_type", () => {
    const started: LocationSharingStartedWebhookEvent = {
      api_version: "v1",
      webhook_version: "2026-08-30",
      event_type: "location.sharing.started",
      event_id: "01a0cf5e-b68b-745b-aff8-ebed0687aa83",
      created_at: "2026-09-23T17:44:45.962Z",
      trace_id: "b2a0406d1468b51bd88bee19fc19d4d1",
      agent_id: "01a0cf5d-9f44-74df-bcca-b0fdf47392d4",
      data: {
        shared_by: "alice",
        shared_with: "echo",
        chat_id: chatID,
        began_at: "2026-09-23T17:44:45.947Z",
        ends_at: "2026-09-23T18:44:45.924Z",
      },
    };
    const stopped: LocationSharingStoppedWebhookEvent = {
      ...started,
      event_type: "location.sharing.stopped",
      event_id: "01a0cf5e-e15d-7412-849c-c460856c976b",
      data: {
        shared_by: "alice",
        shared_with: "echo",
        chat_id: chatID,
        began_at: "2026-09-23T17:44:45.947Z",
        ended_at: "2026-09-23T17:44:56.924Z",
      },
    };
    const describeEvent = (event: RelayWebhookEvent): string => {
      switch (event.event_type) {
        case "location.sharing.started":
          return `${event.data.shared_by} until ${event.data.ends_at ?? "no end"}`;
        case "location.sharing.stopped":
          return `${event.data.shared_by} stopped at ${event.data.ended_at}`;
        default:
          return "other";
      }
    };
    expect(describeEvent(started)).toBe("alice until 2026-09-23T18:44:45.924Z");
    expect(describeEvent(stopped)).toBe("alice stopped at 2026-09-23T17:44:56.924Z");
  });

  it("reads location_request and location parts on a Message", () => {
    const message: Message = {
      id: "01a0cf5e-b680-75d1-b1b0-d23620955fab",
      chat_id: chatID,
      from: "alice",
      parts: [
        { type: "location_request", reactions: null },
        {
          type: "location",
          state: "ended",
          began_at: "2026-09-23T17:44:45.947Z",
          ends_at: "2026-09-23T18:44:45.924Z",
          ended_at: "2026-09-23T17:44:56.924Z",
          reactions: null,
        },
      ],
      is_system_message: false,
      is_from_me: false,
      delivery_status: "delivered",
      created_at: "2026-09-23T17:44:45.952Z",
      updated_at: "2026-09-23T17:44:56.924Z",
    };
    expect(message.parts!.map((part) => part.type)).toEqual(["location_request", "location"]);
    expect(schema("LocationPartResponse"))
      .toContain("required: [type, state, began_at, ends_at, ended_at, reactions]");
    expect(schema("LocationPartResponse")).toContain("enum: [live, ended]");
    expect(schema("LocationRequestPartResponse")).toContain("required: [type, reactions]");
    expect(contract).toContain('location_request: "#/components/schemas/LocationRequestPartResponse"');
    expect(contract).toContain('location: "#/components/schemas/LocationPartResponse"');
  });
});
