import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  RELAY_API_VERSION,
  RELAY_WEBHOOK_EVENT_TYPES,
  RELAY_WEBHOOK_VERSION,
  type RelayChatHandle,
} from "../src/index.js";

const OPENAPI_SHA =
  "4758ee873ab6c350791c179c10ee66307c2065cf3d1083684a4c831c269ed937";

interface PackageIdentity {
  bugs: { url: string };
  repository: {
    type: string;
    url: string;
    directory: string;
  };
}

interface OpenApiDocument {
  components: {
    schemas: Record<string, Record<string, unknown>>;
  };
  paths: Record<string, Record<string, unknown>>;
  servers: Array<{ url: string }>;
}

describe("locked Relay Server contract", () => {
  it("carries optional Chat activity without inventing an agent event", async () => {
    const document = parse(await readFile(
      new URL("../contracts/relay-openapi.yaml", import.meta.url), "utf8",
    )) as OpenApiDocument;
    const handle = {
      id: "agent", handle: "fixture", kind: "agent",
      joined_at: "2026-09-20T12:00:00Z", image_url: null, display_name: null,
      subtitle: null, verified: false, is_contact: true,
      activity_version: "9007199254740993",
      activity: {
        id: "task", text: "Generating image", emoji: "🖼️",
        updated_at: "2026-09-20T12:00:00Z", expires_at: "2026-09-20T12:01:30Z",
      },
    } satisfies RelayChatHandle;
    expect(handle.activity_version).toBe("9007199254740993");
    const chatHandle = document.components.schemas.ChatHandle as {
      properties: Record<string, unknown>; required: string[];
    };
    expect(chatHandle.properties).toHaveProperty("activity_version");
    expect(chatHandle.properties).toHaveProperty("activity");
    expect(chatHandle.required).not.toContain("activity");
    expect(chatHandle.required).not.toContain("activity_version");
    expect(RELAY_WEBHOOK_EVENT_TYPES).not.toContain("chat.activity.updated");
  });

  it("publishes from the canonical Relay-SDK package directory", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL("../package.json", import.meta.url),
        "utf8",
      ),
    ) as PackageIdentity;
    const source = JSON.parse(
      await readFile(
        new URL("../SOURCE.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>;
    const sourceLock = JSON.parse(
      await readFile(
        new URL("../../../sources.lock.json", import.meta.url),
        "utf8",
      ),
    ) as {
      imports: Record<string, Record<string, string>>;
    };
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
      directory: "packages/chat-sdk-adapter",
    });
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/RelayMessenger/Relay-SDK/issues",
    });
    expect(source).toEqual({
      ...sourceLock.imports["packages/chat-sdk-adapter"],
      imported_at: "2026-09-01",
      canonical: "Relay-SDK",
    });
  });

  it("uses the exact canonical Server OpenAPI", async () => {
    const source = await readFile(
      new URL("../contracts/relay-openapi.yaml", import.meta.url),
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      OPENAPI_SHA,
    );
  });

  it("carries selection prompts and metadata separately through request and event contracts", async () => {
    const document = parse(await readFile(new URL("../contracts/relay-openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument;
    const schemas = document.components.schemas;
    expect(schemas.SelectionPart).toHaveProperty("additionalProperties", false);
    expect(schemas.SelectionPart).toHaveProperty("properties.options.minItems", 1);
    expect(schemas.SelectionPart).toHaveProperty("properties.options.maxItems", 25);
    expect(schemas.SelectionPartResponse).toHaveProperty("properties.has_responded.readOnly", true);
    expect(schemas.SelectionPartResponse).toHaveProperty("properties.selected_values.readOnly", true);
    expect(schemas.SelectionResponsePart).toHaveProperty("required", ["type", "selected_values"]);
    expect(schemas.SelectionResponsePart).toHaveProperty("properties.selected_values.uniqueItems", true);
    expect(schemas.MessagePart).toHaveProperty("discriminator.mapping.selection", "#/components/schemas/SelectionPart");
    expect(schemas.MessagePart).toHaveProperty("discriminator.mapping.selection_response", "#/components/schemas/SelectionResponsePart");
    for (const name of ["Message", "MessageEvent", "SentMessage"]) {
      expect(schemas[name]).toHaveProperty("properties.parts.items.oneOf", expect.arrayContaining([
        { $ref: "#/components/schemas/SelectionPartResponse" },
        { $ref: "#/components/schemas/SelectionResponsePartResponse" },
        { $ref: "#/components/schemas/ButtonsPartResponse" },
      ]));
    }
  });

  it("carries the payment part, its read-back fields, the receipt and the payment request routes", async () => {
    const document = parse(await readFile(new URL("../contracts/relay-openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument;
    const schemas = document.components.schemas;
    expect(schemas.PaymentPart).toHaveProperty("additionalProperties", false);
    expect(schemas.PaymentPart).toHaveProperty("required", ["type", "checkout_url"]);
    expect(schemas.PaymentPart).toHaveProperty("properties.checkout_url.maxLength", 2048);
    expect(schemas.PaymentPartResponse).toHaveProperty("required", [
      "type", "payment_request_id", "checkout_url", "amount", "currency", "description", "category", "mode", "status", "reactions",
    ]);
    expect(schemas.PaymentReceiptPartResponse).toHaveProperty("required", [
      "type", "payment_request_id", "description", "amount", "currency", "mode", "reactions",
    ]);
    expect(schemas.PaymentCategory).toHaveProperty("enum", ["physical_goods", "digital_goods", "donation"]);
    expect(schemas.PaymentStatus).toHaveProperty("enum", ["requested", "succeeded", "canceled", "expired"]);
    expect(schemas.PaymentRecurring).toHaveProperty("required", ["interval", "interval_count"]);
    expect(schemas.MessagePart).toHaveProperty("discriminator.mapping.payment", "#/components/schemas/PaymentPart");
    for (const name of ["Message", "MessageEvent", "SentMessage"]) {
      expect(schemas[name]).toHaveProperty("properties.parts.items.oneOf", expect.arrayContaining([
        { $ref: "#/components/schemas/PaymentPartResponse" },
        { $ref: "#/components/schemas/PaymentReceiptPartResponse" },
      ]));
    }
    expect(schemas.CreatePaymentRequestRequest).toHaveProperty("required", ["description", "category"]);
    expect(schemas.PaymentRequest).toHaveProperty("required", [
      "id", "object", "status", "mode", "amount", "application_fee_amount", "currency", "description", "category", "checkout_url",
      "expires_at", "metadata", "stripe", "created_at", "updated_at",
    ]);
    expect(document.paths["/v1/payment_requests"]).toHaveProperty("post.operationId", "createPaymentRequest");
    expect(document.paths["/v1/payment_requests"]).toHaveProperty("get.operationId", "listPaymentRequests");
    expect(document.paths["/v1/payment_requests/{paymentRequestId}"]).toHaveProperty("get.operationId", "getPaymentRequest");
    expect(document.paths["/v1/payment_requests/{paymentRequestId}/cancel"]).toHaveProperty("post.operationId", "cancelPaymentRequest");
  });

  it("carries the location parts, both location events and the two location routes", async () => {
    const document = parse(await readFile(new URL("../contracts/relay-openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument;
    const schemas = document.components.schemas;
    expect(schemas.LocationRequestPartResponse).toHaveProperty("required", ["type", "reactions"]);
    expect(schemas.LocationPartResponse).toHaveProperty("required", ["type", "state", "began_at", "ends_at", "ended_at", "reactions"]);
    expect(schemas.LocationPartResponse).toHaveProperty("properties.state.enum", ["live", "ended"]);
    for (const name of ["Message", "MessageEvent", "SentMessage"]) {
      expect(schemas[name]).toHaveProperty("properties.parts.items.oneOf", expect.arrayContaining([
        { $ref: "#/components/schemas/LocationRequestPartResponse" },
        { $ref: "#/components/schemas/LocationPartResponse" },
      ]));
    }
    expect(schemas.WebhookEventType).toHaveProperty("enum", expect.arrayContaining(["location.sharing.started", "location.sharing.stopped"]));
    expect(document.paths["/v1/chats/{chatId}/location/request"]).toHaveProperty("post.operationId", "requestLocation");
    expect(document.paths["/v1/chats/{chatId}/location"]).toHaveProperty("get.operationId", "getLocation");
  });

  it("caps both recipient arrays at six without changing generic admission APIs", async () => {
    const document = parse(await readFile(
      new URL("../contracts/relay-openapi.yaml", import.meta.url), "utf8",
    )) as OpenApiDocument;
    for (const schema of ["CreateChatRequest", "SendMessageRequest"]) {
      expect(document.components.schemas[schema]).toHaveProperty("properties.to.maxItems", 6);
      expect(document.components.schemas[schema]).toHaveProperty("properties.to.minItems", 1);
    }
    expect(document.paths["/v1/chats/{chatId}/participants"]).toHaveProperty("post");
    expect(document.paths["/v1/chats/{chatId}/participants"]).toHaveProperty("delete");
    expect(document.paths["/v1/chats/{chatId}/leave"]).toHaveProperty("post");
  });

  it("pins only public methods the adapter calls", async () => {
    const document = parse(
      await readFile(
        new URL("../contracts/relay-openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    expect(document.servers[0]?.url).toBe(
      "https://api.relayapp.im",
    );
    expect(
      Object.keys(
        document.paths["/v1/chats/{chatId}/messages"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["get", "post"]));
    expect(
      Object.keys(
        document.paths["/v1/chats/{chatId}/typing"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["post", "delete"]));
    expect(
      document.paths["/v1/chats/{chatId}/read"],
    ).toHaveProperty("post");
    expect(
      document.paths["/v1/messages/{messageId}/reactions"],
    ).toHaveProperty("post");
    expect(document.paths["/v1/attachments"]).toHaveProperty(
      "post",
    );
    expect(document.paths["/v1/messages/{messageId}"]).toHaveProperty(
      "get",
    );
    // Relay retired message editing and unsending from the developer API on
    // Relay Server aa456b46, so a Message carries only a read verb.
    expect(document.paths["/v1/messages/{messageId}"]).not.toHaveProperty(
      "patch",
    );
    expect(document.paths["/v1/messages/{messageId}"]).not.toHaveProperty(
      "delete",
    );
    const chatHandle = document.components.schemas.ChatHandle as {
      properties: Record<string, unknown>;
      required: string[];
    };
    // Relay Server 56f31c1 renamed ChatHandle.about to subtitle.
    expect(chatHandle.required).toEqual(expect.arrayContaining([
      "image_url",
      "subtitle",
    ]));
    expect(chatHandle.required).not.toContain("avatar_url");
    expect(chatHandle.required).not.toContain("tagline");
    expect(chatHandle.properties).toHaveProperty("image_url");
    expect(chatHandle.properties).toHaveProperty("subtitle");
    expect(chatHandle.properties).not.toHaveProperty("avatar_url");
    expect(chatHandle.properties).not.toHaveProperty("tagline");
  });

  it("keeps API/webhook versions and every event synchronized", async () => {
    const document = parse(
      await readFile(
        new URL("../contracts/relay-openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    const envelope = document.components.schemas.WebhookEnvelopeBase as {
      properties: {
        api_version: { enum: string[] };
        webhook_version: { enum: string[] };
      };
    };
    const events = document.components.schemas.WebhookEventType as {
      enum: string[];
    };
    expect(envelope.properties.api_version.enum).toEqual([
      RELAY_API_VERSION,
    ]);
    expect(envelope.properties.webhook_version.enum).toEqual([
      RELAY_WEBHOOK_VERSION,
    ]);
    expect(events.enum).toEqual([...RELAY_WEBHOOK_EVENT_TYPES]);
  });
});
