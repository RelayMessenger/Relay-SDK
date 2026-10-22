import { readFileSync } from "node:fs";
import { expect, expectTypeOf, it } from "vitest";
import YAML from "yaml";
import type {
  A2uiActionMessage,
  A2uiAgentToRendererMessage,
  A2uiRendererCapabilities,
  DataPart,
  DataPartResponse,
  MessageContent,
  MessagePart,
  MessagePartResponse,
  MessageWebhookData,
  SentMessage,
} from "../src/index.js";
import { Webhooks, signWebhookHeaders } from "../src/index.js";

const contract = YAML.parse(readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"));
const schemas = contract.components.schemas;
const SECRET = "whsec_" + "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const RELAY_CATALOG = "https://relayapp.im/a2ui/catalogs/relay/v1/catalog.json";
const BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

const card: DataPart = {
  type: "data",
  media_type: "application/a2ui+json",
  data: [
    { version: "v1.0", createSurface: { surfaceId: "order-1", catalogId: BASIC_CATALOG } },
    { version: "v1.0", updateComponents: { surfaceId: "order-1", components: [
      { id: "root", component: "Button", child: "label", action: { event: { name: "confirm" } } },
      { id: "label", component: "Text", text: "Confirm" },
    ] } },
  ],
};

it("carries the contract's DataPart and DataPartResponse exactly as the SDK types them", () => {
  expect(schemas.DataPart.required).toEqual(["type", "media_type", "data"]);
  expect(schemas.DataPart.additionalProperties).toBe(false);
  expect(schemas.DataPart.properties.type.enum).toEqual(["data"]);
  expect(schemas.DataPart.properties.media_type.enum).toEqual(["application/a2ui+json"]);
  expect(schemas.DataPart.properties.data.minItems).toBe(1);
  expect(schemas.DataPartResponse.required).toEqual(["type", "media_type", "data", "reactions"]);
  expect(schemas.MessagePart.oneOf).toContainEqual({ $ref: "#/components/schemas/DataPart" });
  expect(schemas.MessagePart.discriminator.mapping.data).toBe("#/components/schemas/DataPart");
  for (const name of ["Message", "SentMessage", "MessageEvent"]) {
    expect(schemas[name].properties.parts.items.oneOf).toContainEqual({ $ref: "#/components/schemas/DataPartResponse" });
  }
  expect(Object.keys(schemas.MessageEvent.properties.metadata.properties)).toEqual(["a2uiRendererCapabilities"]);
  expect(schemas.MessageEvent.properties.metadata.properties.a2uiRendererCapabilities.required).toEqual(["v1.0"]);

  expectTypeOf<DataPart>().toExtend<MessagePart>();
  expectTypeOf<DataPartResponse>().toExtend<MessagePartResponse>();
  expectTypeOf<DataPartResponse>().toExtend<SentMessage["parts"][number]>();
  expectTypeOf<MessageWebhookData["metadata"]>().toEqualTypeOf<{ a2uiRendererCapabilities?: A2uiRendererCapabilities } | undefined>();
});

it("an A2UI card round-trips through a send body unchanged", () => {
  const content: MessageContent = { parts: [{ type: "text", value: "Your order" }, card] };
  const wire = JSON.parse(JSON.stringify(content)) as MessageContent;
  expect(wire).toEqual(content);
  const sent = wire.parts[1];
  expect(sent?.type).toBe("data");
  if (sent?.type !== "data") throw new Error("not a data part");
  expect(sent.media_type).toBe("application/a2ui+json");
  const first: A2uiAgentToRendererMessage = sent.data[0];
  expect("createSurface" in first && first.createSurface.catalogId).toBe(BASIC_CATALOG);
});

it("a received tap is a typed A2UI action, and the renderer capabilities are readable", () => {
  const tap: A2uiActionMessage = { version: "v1.0", action: {
    name: "confirm", surfaceId: "order-1", sourceComponentId: "root",
    timestamp: "2026-10-22T12:00:00Z", context: { qty: 2 },
  } };
  const body = JSON.stringify({
    api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received", event_id: "evt_a2ui_1",
    created_at: "2026-10-22T12:00:00Z", trace_id: "0123456789abcdef0123456789abcdef", agent_id: "00000000-0000-7000-8000-000000000021",
    data: {
      chat: { id: "6f6a2e1c-0c3b-4c4e-9a8e-0f1e2d3c4b5a", is_group: false },
      chat_id: "6f6a2e1c-0c3b-4c4e-9a8e-0f1e2d3c4b5a",
      id: "9b1d2c3e-4f5a-4b6c-8d7e-1f2a3b4c5d6e",
      direction: "inbound", sender_handle: null, is_from_me: false,
      parts: [{ type: "data", media_type: "application/a2ui+json", data: [tap], reactions: null }],
      metadata: { a2uiRendererCapabilities: { "v1.0": { supportedCatalogIds: [RELAY_CATALOG, BASIC_CATALOG] } } },
    },
  });
  const event = new Webhooks(SECRET).unwrap(body, { headers: signWebhookHeaders(SECRET, { id: "evt_a2ui_1", body }) });
  if (event.event_type !== "message.received") throw new Error(event.event_type);
  const data: MessageWebhookData = event.data;
  const part = data.parts[0];
  if (part?.type !== "data") throw new Error("not a data part");
  const message = part.data[0];
  if (!message || !("action" in message)) throw new Error("not an action");
  expect(message.action.name).toBe("confirm");
  expect(message.action.surfaceId).toBe("order-1");
  expect(message.action.context).toEqual({ qty: 2 });
  expect(data.metadata?.a2uiRendererCapabilities?.["v1.0"].supportedCatalogIds).toEqual([RELAY_CATALOG, BASIC_CATALOG]);
});
