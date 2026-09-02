import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Relay, {
  RELAY_V1_OPERATIONS,
  RELAY_WEBHOOK_EVENT_TYPES,
} from "../packages/sdk/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readRequiredFile = (path, label) => {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new Error(`${label} is missing or unreadable: ${path}`, { cause });
  }
};
const manifest = JSON.parse(
  readFileSync(resolve(root, "contracts/relay-v1-operations.json"), "utf8"),
);
const canonicalSourcePath = "contracts/relay-v1-openapi.yaml";
assert.equal(
  manifest.source,
  canonicalSourcePath,
  "SDK contract source must remain the carried canonical Server OpenAPI",
);
assert.deepEqual(
  manifest.upstream,
  {
    repository: "https://github.com/RelayMessenger/Relay-Server.git",
    commit: "ddcbccb44b9f85e8c2e3e63fead9b81d52f2bd15",
    path: "contracts/developer/openapi.yaml",
    sha256: "26a6bc047286e09df6ef95f3c6b09f0437260ecc94e12c5fb3ce1704910f8ba1",
  },
  "SDK contract provenance must identify the exact canonical Server source",
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
  "POST /v1/contact_requests",
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
assert.equal(manifest.operation_count, 34);
assert.equal(manifest.path_count, 21);
assert.equal(manifest.source_path_count, 22);
assert.equal(manifest.source_schema_count, 105);
assert.equal(manifest.callback_count, 15);
assert.equal(new Set(operationJSON.map((operation) => operation.path)).size, 21);
assert.equal(operationJSON.length, 34);
assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 15);
assert.equal(
  operationJSON.every((operation) => operation.path.startsWith("/v1/")),
  true,
  "Every SDK operation must stay in the Relay /v1 namespace",
);
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
assert.deepEqual(
  operationJSON.filter((operation) =>
    operation.operationId === "markChatAsRead"
    || operation.path.endsWith("/read")),
  [{
    method: "POST",
    path: "/v1/chats/{chatId}/read",
    operationId: "markChatAsRead",
  }],
  "Read must remain the single explicit Chat operation",
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
assert.deepEqual(
  operationJSON.filter((operation) =>
    operation.path === "/v1/contact_requests"),
  [{
    method: "POST",
    path: "/v1/contact_requests",
    operationId: "createContactRequest",
  }],
  "Only the public Agent Add-request operation belongs in the SDK",
);
for (const unsupported of [
  "/v1/broadcasts",
  "/v1/proactive_messages",
  "/v1/installations",
]) {
  assert.equal(
    operationJSON.some((operation) => operation.path === unsupported),
    false,
    `${unsupported} is not a Relay API`,
  );
}

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
  "contactRequests",
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
assert.deepEqual(publicMethods(client.contactRequests), ["create"]);
assert.deepEqual(publicMethods(client.blockedHandles), [
  "block",
  "list",
  "unblock",
]);
assert.deepEqual(publicMethods(client.websocket), ["run"]);
assert.deepEqual(publicMethods(client.webhooks), ["unwrap", "verify"]);

assert.deepEqual(
  manifest.transport_decision,
  {
    source: "contracts/agent-transport-decision.md",
    sha256: "6140351159f830a4a6b4be67e2e6a9cce27eeb9a6cd83c67c54331df26d2fe74",
    upstream: {
      repository: "https://github.com/RelayMessenger/Relay-Research.git",
      commit: "2c876f70ea360164849169187aca622b88f8e319",
      path: "research/relay-rebuild-20260828/TRANSPORT-DECISION-20260829.md",
    },
  },
  "SDK transport provenance must identify the exact Research source",
);
const decision = resolve(root, manifest.transport_decision.source);
const decisionHash = createHash("sha256")
  .update(readRequiredFile(decision, "Final Agent transport decision"))
  .digest("hex");
assert.equal(
  decisionHash,
  manifest.transport_decision.sha256,
  "Final Agent transport decision changed; refresh SDK behavior",
);

const source = process.env.RELAY_OPENAPI_SOURCE
  ?? resolve(root, canonicalSourcePath);
const validateOpenAPI = () => {
  const bytes = readRequiredFile(source, "Relay OpenAPI");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    hash,
    manifest.source_openapi_sha256,
    "Relay OpenAPI changed; refresh SDK contract",
  );
  const document = YAML.parse(bytes.toString("utf8"));
  assert.equal(document.openapi, "3.1.0");
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
  for (const [name, callback] of Object.entries(document["x-relay-webhooks"])) {
    assert.equal(name.endsWith(".v2026-08-30"), true);
    assert.deepEqual(callback.post.tags, ["2026-08-30"]);
    assert.equal(callback.post.operationId.endsWith("V20260830"), true);
  }
  assert.deepEqual(
    document.components.schemas.WebhookEventType.enum,
    [...RELAY_WEBHOOK_EVENT_TYPES],
  );
  assert.deepEqual(
    document.components.schemas.WebhookEnvelopeBase.properties.api_version.enum,
    ["v1"],
  );
  assert.deepEqual(
    document.components.schemas.WebhookEnvelopeBase.properties.webhook_version.enum,
    ["2026-08-30"],
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
      "display_name",
      "image_url",
      "about",
      "verified",
    ],
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
      "image_url",
      "about",
      "verified",
    ],
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.about.maxLength,
    60,
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.image_url.description,
    "Current Contact picture, as a permanent address served by Relay. It does not expire and may be cached indefinitely.",
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.about.description,
    "About text for an agent. User Contacts return null.",
  );
  assert.equal(
    "avatar_url" in document.components.schemas.ChatHandle.properties,
    false,
    "ChatHandle.avatar_url must not remain as a compatibility alias",
  );
  assert.equal(
    "tagline" in document.components.schemas.ChatHandle.properties,
    false,
    "ChatHandle.tagline must not remain as a compatibility alias",
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.verified.type,
    "boolean",
  );
  for (const privateField of [
    "greeting_message",
    "is_default",
    "is_premium_handle",
    "billing_plan",
    "installation",
  ]) {
    assert.equal(
      privateField in document.components.schemas.ChatHandle.properties,
      false,
      `ChatHandle.${privateField} must not enter the SDK`,
    );
  }
  assert.deepEqual(
    document.components.schemas.CreateContactRequest.required,
    ["handle"],
  );
  assert.equal(
    document.components.schemas.CreateContactRequest.additionalProperties,
    false,
  );
  assert.deepEqual(
    Object.keys(document.components.schemas.CreateContactRequest.properties),
    ["handle"],
  );
  assert.deepEqual(
    document.paths["/v1/contact_requests"].post.parameters ?? [],
    [],
    "Contact requests must not advertise idempotency",
  );
  for (const path of [
    "/v1/chats",
    "/v1/messages",
    "/v1/chats/{chatId}/messages",
  ]) {
    const idempotencyHeaders = (
      document.paths[path].post.parameters ?? []
    ).filter((parameter) =>
      parameter.name === "Idempotency-Key"
      && parameter.in === "header"
    );
    assert.equal(
      idempotencyHeaders.length,
      1,
      `${path} must retain its Idempotency-Key header`,
    );
    assert.equal(idempotencyHeaders[0].required, false);
    assert.equal(idempotencyHeaders[0].schema.type, "string");
    assert.equal(idempotencyHeaders[0].schema.maxLength, 255);
  }
  assert.deepEqual(
    document.components.schemas.MessageContent.required,
    ["parts"],
  );
  assert.equal(
    document.components.schemas.MessageContent.properties.idempotency_key.type,
    "string",
  );
  assert.equal(
    document.components.schemas.MessageContent.properties
      .idempotency_key.maxLength,
    255,
  );
  assert.deepEqual(
    document.components.schemas.CreateContactRequestResult
      .properties.state.enum,
    ["pending"],
  );
  assert.ok(
    document.paths["/v1/contact_requests"].post.responses["402"],
    "Contact requests must expose paid-agent HTTP 402 behavior",
  );
  assert.deepEqual(
    document.components.schemas.ContactAddedEvent.required,
    ["contact", "chat_id"],
  );
  assert.deepEqual(
    document.components.schemas.ContactRemovedEvent.required,
    ["contact"],
  );
  assert.deepEqual(
    document.components.schemas.ContactEventContact.required,
    ["id", "handle", "display_name"],
  );
  assert.equal(
    document["x-relay-webhooks"]["contact.added.v2026-08-30"].post
      .requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ContactAddedWebhook",
  );
  assert.equal(
    document["x-relay-webhooks"]["contact.removed.v2026-08-30"].post
      .requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ContactRemovedWebhook",
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
  assert.equal(document.components.schemas.SupportedContentType, undefined);
  const mimeTypePattern = "^[A-Za-z0-9!#$%&'*+.^_`|~-]+/[A-Za-z0-9!#$%&'*+.^_`|~-]+$";
  for (const schemaName of ["Attachment", "RequestUploadRequest"]) {
    const contentType = document.components.schemas[schemaName]
      .properties.content_type;
    assert.equal(contentType.type, "string");
    assert.equal(contentType.maxLength, 255);
    assert.equal(contentType.pattern, mimeTypePattern);
  }
};
validateOpenAPI();

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
