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
const canonicalSourcePath =
  "_worktrees/Relay-Server-local/contracts/developer/openapi.yaml";
assert.equal(
  manifest.source,
  canonicalSourcePath,
  "SDK contract source must remain the canonical Server developer OpenAPI",
);
// The WebSocket upgrade is documented in OpenAPI but is implemented by
// runWebSocket rather than as a generated REST resource method.
const sourceOnlyOperations = [
  {
    method: "GET",
    path: "/v1/websocket",
    operationId: "connectAgentWebSocket",
  },
];
const allowedOperationSignatures = [
  "POST /v1/chats",
  "GET /v1/chats",
  "GET /v1/chats/{chatId}",
  "PUT /v1/chats/{chatId}",
  "POST /v1/chats/{chatId}/participants",
  "DELETE /v1/chats/{chatId}/participants",
  "POST /v1/chats/{chatId}/leave",
  "POST /v1/chats/{chatId}/typing",
  "DELETE /v1/chats/{chatId}/typing",
  "POST /v1/chats/{chatId}/read",
  "POST /v1/chats/{chatId}/share_contact_card",
  "POST /v1/messages",
  "POST /v1/chats/{chatId}/messages",
  "GET /v1/chats/{chatId}/messages",
  "GET /v1/messages/{messageId}/thread",
  "POST /v1/chats/{chatId}/voicememo",
  "GET /v1/messages/{messageId}",
  "POST /v1/messages/{messageId}/reactions",
  "POST /v1/attachments",
  "GET /v1/attachments/{attachmentId}",
  "DELETE /v1/attachments/{attachmentId}",
  "GET /v1/blocked_handles",
  "POST /v1/blocked_handles",
  "DELETE /v1/blocked_handles",
  "GET /v1/webhook-events",
  "POST /v1/webhook-subscriptions",
  "GET /v1/webhook-subscriptions",
  "GET /v1/webhook-subscriptions/{subscriptionId}",
  "PUT /v1/webhook-subscriptions/{subscriptionId}",
  "DELETE /v1/webhook-subscriptions/{subscriptionId}",
  "GET /v1/contact_card",
  "POST /v1/contact_card",
  "PATCH /v1/contact_card",
];
const forbiddenPathPrefixes = [
  "/v1/me/",
  "/v1/client/",
  "/v1/console/",
  "/v1/internal/",
  "/api/auth/",
];
const operationJSON = RELAY_V1_OPERATIONS.map((operation) => ({ ...operation }));
assert.deepEqual(operationJSON, manifest.operations);
assert.equal(manifest.operation_count, 33);
assert.equal(manifest.path_count, 20);
assert.equal(manifest.source_path_count, 21);
assert.equal(manifest.source_schema_count, 99);
assert.equal(manifest.callback_count, 13);
assert.equal(new Set(operationJSON.map((operation) => operation.path)).size, 20);
assert.equal(operationJSON.length, 33);
assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 13);
assert.deepEqual(
  operationJSON.map((operation) => `${operation.method} ${operation.path}`),
  allowedOperationSignatures,
  "SDK REST operations must remain inside the approved public allowlist",
);
for (const prefix of forbiddenPathPrefixes) {
  assert.equal(
    operationJSON.some((operation) => operation.path.startsWith(prefix)),
    false,
    `private route prefix leaked into SDK: ${prefix}`,
  );
}
assert.equal(
  operationJSON.some(
    (operation) => operation.operationId === "acknowledgeMessageDelivered",
  ),
  false,
  "user delivery acknowledgement leaked into SDK",
);

for (const forbidden of [
  "/v1/events",
  "/realtime",
  "/responding",
  "/api/partner",
  "/api/mobile",
  "/socket-mode",
  "/socket-connections",
  "/v1/contacts",
]) {
  assert.equal(
    operationJSON.some((operation) => operation.path.includes(forbidden)),
    false,
    `unsupported path leaked into SDK: ${forbidden}`,
  );
}
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/chats/{chatId}/share_contact_card"));
assert.equal(operationJSON.some((operation) =>
  operation.path === "/v1/websocket"), false);
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
const publicMethods = (value) =>
  Object.getOwnPropertyNames(Object.getPrototypeOf(value))
    .filter((name) => name !== "constructor")
    .sort();
assert.deepEqual(Object.keys(client).sort(), [
  "attachments",
  "baseURL",
  "blockedHandles",
  "chats",
  "contactCard",
  "messages",
  "webhookEvents",
  "webhookSubscriptions",
  "webhooks",
  "websocket",
]);
assert.deepEqual(publicMethods(client.chats), [
  "create",
  "leaveChat",
  "listChats",
  "markAsRead",
  "retrieve",
  "sendVoicememo",
  "shareContactCard",
  "startTyping",
  "stopTyping",
  "update",
]);
assert.deepEqual(publicMethods(client.messages), [
  "addReaction",
  "create",
  "listMessagesThread",
  "retrieve",
]);
assert.deepEqual(publicMethods(client.chats.messages), ["list", "send"]);
assert.deepEqual(publicMethods(client.chats.participants), ["add", "remove"]);
assert.deepEqual(publicMethods(client.attachments), [
  "create",
  "delete",
  "retrieve",
  "upload",
]);
assert.deepEqual(publicMethods(client.webhookEvents), ["list"]);
assert.deepEqual(publicMethods(client.webhookSubscriptions), [
  "create",
  "delete",
  "list",
  "retrieve",
  "update",
]);
assert.deepEqual(publicMethods(client.contactCard), [
  "create",
  "retrieve",
  "update",
]);
assert.deepEqual(publicMethods(client.blockedHandles), [
  "block",
  "list",
  "unblock",
]);
assert.deepEqual(publicMethods(client.websocket), ["run"]);
assert.deepEqual(publicMethods(client.webhooks), ["unwrap", "verify"]);

const decision = resolve(root, "..", manifest.transport_decision.source);
if (existsSync(decision)) {
  const decisionHash = createHash("sha256")
    .update(readFileSync(decision))
    .digest("hex");
  assert.equal(
    decisionHash,
    manifest.transport_decision.sha256,
    "Final Agent transport decision changed; refresh SDK behavior",
  );
}

const source = process.env.RELAY_OPENAPI_SOURCE
  ?? resolve(root, "..", canonicalSourcePath);
if (existsSync(source)) {
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    hash,
    manifest.source_openapi_sha256,
    "Relay OpenAPI changed; refresh SDK contract",
  );
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
  assert.equal(
    Object.keys(document.paths).length,
    manifest.source_path_count,
  );
  assert.equal(
    Object.keys(document.components.schemas).length,
    manifest.source_schema_count,
  );
  const excluded = new Set(
    sourceOnlyOperations.map((operation) =>
      `${operation.method} ${operation.path} ${operation.operationId}`
    ),
  );
  assert.deepEqual(
    sourceOperations.filter((operation) =>
      !excluded.has(
        `${operation.method} ${operation.path} ${operation.operationId}`,
      )
    ),
    manifest.operations,
  );
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
  assert.equal(
    document["x-relay-websocket-close-codes"]["4410"],
    "Webhook delivery is now configured for this Agent.",
  );
  assert.equal(
    "4409" in document["x-relay-websocket-close-codes"],
    false,
  );
  assert.deepEqual(
    document.components.schemas.WebSocketDisconnectFrame.properties.reason.enum,
    ["revoked", "heartbeat_timeout", "restart", "webhook_configured"],
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
    document.components.schemas.ChatHandle.required,
    [
      "id",
      "handle",
      "joined_at",
      "kind",
      "greeting_message",
    ],
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.greeting_message.maxLength,
    1024,
  );
  assert.deepEqual(
    Object.keys(document.components.schemas.ChatHandle.properties),
    [
      "id",
      "handle",
      "status",
      "joined_at",
      "left_at",
      "is_me",
      "kind",
      "display_name",
      "avatar_url",
      "greeting_message",
    ],
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
  package: "@relaymessenger/sdk",
  paths: manifest.path_count,
  operations: operationJSON.length,
  source_schemas: manifest.source_schema_count,
  callbacks: manifest.callback_count,
  openapi_sha256: manifest.source_openapi_sha256,
  transport_decision_sha256: manifest.transport_decision.sha256,
}));
