import assert from "node:assert/strict";
import { pinReachability } from "./contract-pin.mjs";
import { spawnSync } from "node:child_process";
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
const declaredTypes = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../packages/sdk/dist/types.d.ts"),
  "utf8",
);
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
    commit: "7588db1e0cfbce423fd34505b92198b946543aa7",
    path: "contracts/developer/openapi.yaml",
    sha256: "049c4e5d9606af2781601e510952845d85c4ab5aeaaf00272566e3ba1d1b3c69",
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
  "POST /v1/agents",
  "DELETE /v1/agents/{handle}",
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
assert.equal(manifest.operation_count, 35);
assert.equal(manifest.path_count, 22);
assert.equal(manifest.source_path_count, 23);
assert.equal(manifest.source_schema_count, 114);
assert.equal(manifest.callback_count, 17);
assert.equal(new Set(operationJSON.map((operation) => operation.path)).size, 22);
assert.equal(operationJSON.length, 35);
assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 17);
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
assert.equal(
  operationJSON.some((operation) => operation.path === "/v1/contact_requests"),
  false,
  "add requests are gone; the first Message is the request",
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
  "agents",
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
assert.equal(typeof Relay.createAgent, "function");
assert.deepEqual(publicMethods(client.agents), ["delete"]);
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
  const bootstrap = document.paths["/v1/agents"].post;
  assert.deepEqual(Object.keys(document.paths["/v1/agents"]), ["post"]);
  assert.deepEqual(Object.keys(document.paths["/v1/agents/{handle}"]), ["delete"]);
  assert.equal(bootstrap.operationId, "createAgent");
  assert.deepEqual(bootstrap.security, []);
  assert.equal(bootstrap.requestBody.required, true);
  assert.equal(bootstrap.requestBody.content["application/json"].schema.$ref, "#/components/schemas/CreateAgentRequest");
  assert.equal(bootstrap.responses["201"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(bootstrap.responses["201"].content["application/json"].schema.$ref, "#/components/schemas/CreateAgentResponse");
  const createParams = document.components.schemas.CreateAgentRequest;
  assert.equal(createParams.additionalProperties, false);
  assert.deepEqual(Object.keys(createParams.properties), ["about", "token_name", "handle", "first_name", "image_url", "image_recipe"]);
  assert.deepEqual(createParams.dependentRequired, { image_recipe: ["image_url"] });
  assert.equal(createParams.properties.handle.pattern, "^[a-z][a-z0-9_]{2,31}\\.dev$");
  assert.equal(createParams.properties.first_name.maxLength, 30);
  assert.equal(createParams.properties.image_recipe.$ref, "#/components/schemas/AgentImageRecipe");
  assert.equal(document.components.schemas.AgentImageRecipe.oneOf.length, 3);
  assert.deepEqual(document.components.schemas.AgentImageBackground.properties.linearGradient.properties.colors.enum, [
    ["EC8A3C", "C85F1C"], ["E0567A", "AD2A52"], ["D05FC6", "93217E"],
    ["8F6CF2", "5F38CF"], ["5B9BFA", "0B52C0"], ["2596A6", "116A79"], ["2FA46A", "137347"],
  ]);
  assert.equal(createParams.required?.length ?? 0, 0);
  assert.equal(createParams.properties.token_name.minLength, 1);
  assert.equal(createParams.properties.token_name.maxLength, 80);
  assert.equal(createParams.properties.token_name.default, "Relay CLI");
  const created = document.components.schemas.CreateAgentResponse;
  assert.equal(created.additionalProperties, false);
  assert.deepEqual(created.required, ["agent", "secret", "share_url"]);
  assert.deepEqual(Object.keys(created.properties), ["agent", "secret", "share_url"]);
  assert.equal(created.properties.agent.allOf[0].$ref, "#/components/schemas/ContactCardItem");
  assert.equal(created.properties.agent.allOf[1].properties.kind.const, "agent");
  assert.equal(created.properties.secret.readOnly, true);
  assert.equal(Object.hasOwn(document.components.schemas.ContactCardItem.properties, "id"), false);
  const deletion = document.paths["/v1/agents/{handle}"].delete;
  assert.equal(deletion.operationId, "deleteAgent");
  assert.equal(deletion.requestBody, undefined);
  assert.equal(deletion.responses["204"].content, undefined);
  for (const status of ["401", "403", "404", "409"]) assert.ok(deletion.responses[status]);
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (path === "/v1/agents" && method === "post") continue;
      assert.deepEqual(operation.security ?? document.security, [{ BearerAuth: [] }], `${method} ${path} still requires authentication`);
    }
  }
  const addParticipant = document.components.schemas.AddParticipantRequest;
  assert.deepEqual(addParticipant.required, ["handle"]);
  assert.deepEqual(Object.keys(addParticipant.properties).sort(), ["handle", "hide_history"]);
  assert.equal(addParticipant.properties.hide_history.type, "boolean");
  assert.equal(addParticipant.properties.hide_history.default, true);
  assert.match(declaredTypes, /hide_history\?: boolean/u);
  assert.doesNotMatch(declaredTypes, /\b(?:is_hidden|truncated_at)\??:/u);
  assert.match(
    document.paths["/v1/chats/{chatId}/participants"].post.description,
    /Set hide_history to false to also share earlier retained history/u,
  );
  for (const schema of ["CreateChatRequest", "SendMessageRequest"]) {
    assert.equal(document.components.schemas[schema].properties.to.minItems, 1);
    assert.equal(
      document.components.schemas[schema].properties.to.maxItems,
      6,
      `${schema}: at most six recipients plus the sender (seven total)`,
    );
  }
  assert.match(
    document.components.schemas.CreateChatRequest.description,
    /every agent must already be in that user's Contacts and unblocked/u,
  );
  assert.match(
    document.paths["/v1/chats/{chatId}/participants"].post.description,
    /target agent must not be blocked by, or have blocked, that user/u,
  );
  assert.match(
    document.paths["/v1/chats/{chatId}/participants"].delete.description,
    /Any active member may remove one/u,
  );
  assert.match(
    document.paths["/v1/chats/{chatId}/leave"].post.description,
    /existing membership rules/u,
  );
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
      "is_removable",
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
    document.components.schemas.UpdateChatRequest.properties.group_chat_icon
      .description,
    "Group photo for the chat, in either of two forms. A completed image "
      + "Attachment ID uses an image you already uploaded. Any publicly "
      + "reachable HTTPS image address also works: Relay downloads it and "
      + "serves a permanent copy of its own, so the address you supply does "
      + "not have to stay up. Send null to clear the photo.",
  );
  assert.match(
    declaredTypes,
    /HTTPS image address also works[\s\S]{0,200}?group_chat_icon\?: string \| null;/u,
    "A group photo takes an Attachment ID or a public HTTPS image address; "
      + "ChatUpdateParams must publish both forms.",
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
  assert.equal(document.components.schemas.ChatHandle.properties.is_removable.type, "boolean");
  assert.match(declaredTypes, /is_removable\?: boolean;/u);
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
  assert.equal("/v1/contact_requests" in document.paths, false);
  assert.equal("CreateContactRequest" in document.components.schemas, false);
  assert.equal("CreateContactRequestResult" in document.components.schemas, false);
  assert.deepEqual(
    document.components.schemas.Chat.properties.request_state.enum,
    ["pending", "accepted", "deleted"],
  );
  assert.equal(document.components.schemas.Chat.required.includes("request_state"), false);
  assert.match(declaredTypes, /request_state\?: ChatRequestState;/u);
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
    document.components.schemas.ChatRequestUpdatedEvent.required,
    ["chat_id", "state", "updated_at"],
  );
  assert.deepEqual(
    document.components.schemas.ChatRequestUpdatedEvent.properties.state.enum,
    ["accepted", "deleted"],
  );
  assert.equal(
    document["x-relay-webhooks"]["chat.request.updated.v2026-08-30"].post
      .requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ChatRequestUpdatedWebhook",
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

// The skill tells an installed coding agent to read the contract from the
// PUBLIC Relay-SDK mirror at `api.public_source.commit` and check its hash
// against `api.openapi_sha256` (skills/relay/SKILL.md, Ground truth step 2).
// Relay-Server is private, so that commit is the only copy such an agent can
// fetch. Read the pinned commit here rather than trust the two fields to agree:
// on 2026-09-08 they did not, and every skill run would have called our own
// contract stale.
const skillLock = JSON.parse(
  readFileSync(resolve(root, "skills/relay/references/relay-v1-lock.json"), "utf8"),
);
const pinned = skillLock.api.public_source;
const pinnedFile = spawnSync(
  "git",
  ["-C", root, "show", `${pinned.commit}:${pinned.path}`],
  { maxBuffer: 64 * 1024 * 1024 },
);
assert.equal(
  pinnedFile.status,
  0,
  `skill lock api.public_source.commit ${pinned.commit} is not readable in this checkout`
  + ` (fetch the full history): ${String(pinnedFile.stderr)}`,
);
const pinnedDigest = createHash("sha256").update(pinnedFile.stdout).digest("hex");
assert.equal(
  pinnedDigest,
  skillLock.api.openapi_sha256,
  `skill lock: ${pinned.path} at ${pinned.commit} hashes ${pinnedDigest},`
  + ` but api.openapi_sha256 is ${skillLock.api.openapi_sha256};`
  + " point public_source.commit at the commit that carries the locked contract",
);
// A commit that hashes right is still a bad pin when only one machine has it:
// this repository squash-merges, so a PR-branch commit is gone after merge.
// The pin has to be reachable from a durable public ref (scripts/contract-pin.mjs).
const durability = pinReachability({ root, commit: pinned.commit, sha256: skillLock.api.openapi_sha256 });
if (!durability.checked) console.warn(durability.message);
assert.ok(durability.checked === false || durability.reachable, durability.message);

console.log(JSON.stringify({
  ok: true,
  package: "@relaymessenger/sdk",
  paths: manifest.path_count,
  operations: operationJSON.length,
  source_schemas: manifest.source_schema_count,
  callbacks: manifest.callback_count,
  openapi_sha256: manifest.source_openapi_sha256,
  source_commit: manifest.upstream.commit,
  transport_decision_sha256: manifest.transport_decision.sha256,
}));
