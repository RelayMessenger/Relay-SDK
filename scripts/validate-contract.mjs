import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Relay, {
  RELAY_V1_OPERATIONS,
  RELAY_WEBHOOK_EVENT_TYPES,
} from "../packages/sdk/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "contracts/relay-v1-operations.json"), "utf8"),
);
const operationJSON = RELAY_V1_OPERATIONS.map((operation) => ({ ...operation }));
assert.deepEqual(operationJSON, manifest.operations);
assert.equal(manifest.path_count, 22);
assert.equal(manifest.schema_count, 99);
assert.equal(manifest.callback_count, 13);
assert.equal(new Set(operationJSON.map((operation) => operation.path)).size, 22);
assert.equal(operationJSON.length, 36);
assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 13);

for (const forbidden of [
  "/v1/events",
  "/realtime",
  "/responding",
  "/api/partner",
  "/api/mobile",
  "/socket-mode",
  "/socket-connections",
  "/v1/contacts",
  "/v1/me/contacts",
]) {
  assert.equal(
    operationJSON.some((operation) => operation.path.includes(forbidden)),
    false,
    `unsupported path leaked into SDK: ${forbidden}`,
  );
}
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/messages/{messageId}/delivered"));
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/chats/{chatId}/share_contact_card"));
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/websocket"));
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/chats/{chatId}/typing"
  && operation.method === "POST"));
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/chats/{chatId}/typing"
  && operation.method === "DELETE"));
assert.equal(operationJSON.some((operation) =>
  operation.path === "/v1/websocket-connections"), false);

const client = new Relay({
  apiKey: "contract-check",
  fetch: async () => new Response("{}", { status: 200 }),
});
for (const forbidden of [
  "pollEvents",
  "poll",
  "realtime",
  "responding",
  "typing",
  "socketMode",
  "contacts",
]) {
  assert.equal(forbidden in client, false, `unsupported client field: ${forbidden}`);
  assert.equal(forbidden in client.messages, false, `unsupported message field: ${forbidden}`);
  assert.equal(forbidden in client.chats, false, `unsupported chat field: ${forbidden}`);
}

const source = process.env.RELAY_OPENAPI_SOURCE
  ?? resolve(root, "../_worktrees/Relay-Server-local/contracts/developer/openapi.yaml");
if (existsSync(source)) {
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, manifest.sha256, "Relay OpenAPI changed; refresh SDK contract");
  const document = YAML.parse(bytes.toString("utf8"));
  const sourceOperations = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      sourceOperations.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
      });
    }
  }
  assert.equal(Object.keys(document.paths).length, manifest.path_count);
  assert.equal(Object.keys(document.components.schemas).length, manifest.schema_count);
  assert.deepEqual(sourceOperations, manifest.operations);
  assert.equal(
    Object.keys(document["x-relay-webhooks"]).length,
    manifest.callback_count,
  );
  assert.deepEqual(
    document.components.schemas.WebhookEventType.enum,
    [...RELAY_WEBHOOK_EVENT_TYPES],
  );
  assert.deepEqual(
    document.components.schemas.WebhookEnvelopeBase.properties.api_version.enum,
    ["v1"],
  );
  assert.deepEqual(
    document.components.schemas.DeliveryStatus.enum,
    ["sent", "delivered", "read"],
  );
  assert.deepEqual(
    document.components.schemas.WebSocketSettings.required,
    ["enabled", "acked_through", "full_sync_through"],
  );
  assert.deepEqual(
    document.components.schemas.WebSocketSettingsUpdate.required,
    ["enabled"],
  );
  assert.equal(
    document.components.schemas.WebSocketSettings.properties.enabled.type,
    "boolean",
  );
  assert.equal(
    document.components.schemas.WebSocketSettingsUpdate.properties.enabled.type,
    "boolean",
  );
  assert.deepEqual(
    document.components.schemas.WebSocketDisconnectFrame.properties.reason.enum,
    ["disabled", "replaced", "revoked", "heartbeat_timeout", "restart"],
  );
  assert.deepEqual(
    document.components.schemas.WebSocketErrorFrame.properties.code.enum,
    [
      "invalid_frame",
      "ack_out_of_range",
      "stale_connection",
      "ack_failed",
      "delivery_failed",
      "full_sync_required",
      "full_sync_mismatch",
    ],
  );
  assert.deepEqual(
    document["x-relay-websocket-close-codes"],
    {
      "1011": "Relay could not load or commit delivery state; reconnect and resume.",
      "1012": "Relay is restarting; reconnect and resume.",
      "4401": "The Agent Token is invalid, revoked, or WebSocket delivery is disabled.",
      "4408": "The heartbeat timed out.",
      "4409": "A newer connection replaced this one.",
    },
  );
  for (const obsoleteSchema of [
    "SocketModeState",
    "SocketConnection",
    "SocketReadyFrame",
    "SocketEventFrame",
    "SocketAckFrame",
    "WebSocketConnection",
  ]) {
    assert.equal(
      obsoleteSchema in document.components.schemas,
      false,
      `${obsoleteSchema} is obsolete`,
    );
  }
  for (const [schema, fields] of Object.entries({
    Chat: ["health_status", "is_archived"],
    Reaction: ["sticker"],
    SendMessageResult: ["from_selection", "previous_chat_id"],
    Message: ["reconciled_at", "effect", "service", "is_delivered", "is_read"],
    ChatInfo: ["is_active"],
  })) {
    const properties = document.components.schemas[schema].properties;
    for (const field of fields) {
      assert.equal(field in properties, false, `${schema}.${field} is obsolete`);
    }
  }
  assert.ok(
    "deliveries" in document.components.schemas.Message.properties,
    "Message.deliveries is required in the SDK contract",
  );
  assert.deepEqual(
    document.components.schemas.WebSocketReadyFrame.required,
    [
      "type",
      "connection_id",
      "acked_through",
      "full_sync_required",
      "full_sync_through",
      "heartbeat_interval_ms",
      "max_in_flight",
    ],
  );
  assert.deepEqual(
    document.components.schemas.WebSocketFullSyncFrame.properties.reason.enum,
    ["checkpoint_outside_retention"],
  );
  for (const name of [
    "ChatTypingIndicatorStartedEvent",
    "ChatTypingIndicatorStoppedEvent",
  ]) {
    assert.deepEqual(
      document.components.schemas[name].required,
      ["chat_id", "contact"],
    );
    assert.equal(
      document.components.schemas[name].properties.contact.$ref,
      "#/components/schemas/TypingContact",
    );
  }
  assert.equal(
    document.components.schemas.SupportedContentType.enum.includes("image/webp"),
    true,
  );
  assert.equal(
    document.components.schemas.SupportedContentType.enum.includes("image/svg+xml"),
    false,
  );
}

console.log(JSON.stringify({
  ok: true,
  package: "@relayapp/sdk",
  paths: manifest.path_count,
  operations: operationJSON.length,
  schemas: manifest.schema_count,
  callbacks: manifest.callback_count,
  openapi_sha256: manifest.sha256,
}));
