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
// Explicit source-only proof for an uncommitted contract. Default validation
// still requires real Server and durable public SDK commit pins.
const structuralOnly = process.argv.includes("--structural");
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
assert.equal(manifest.upstream.repository, "https://github.com/RelayMessenger/Relay-Server.git");
assert.equal(manifest.upstream.path, "contracts/developer/openapi.yaml");
assert.equal(manifest.upstream.sha256, manifest.source_openapi_sha256);
assert.equal(manifest.upstream.commit, "3b7425e5bafcf25cdc8ceff009715e4f06877d18", "SDK contract provenance must identify the exact canonical Server source");
// The WebSocket upgrade is documented in OpenAPI but is implemented by
// runWebSocket rather than as a generated REST resource method.
// Operations the canonical source declares that this SDK does not yet
// carry. The websocket is a transport, not a client method. The directory
// and rating routes landed on the Server after the last contract carry; the
// selection carry pins the Server bytes that include them, and their client
// methods arrive with their own carry.
const sourceOnlyOperations = [
  { method: "GET", path: "/v1/websocket", operationId: "connectAgentWebSocket" },
  { method: "GET", path: "/v1/calls/{callId}/room", operationId: "connectCallRoom" },
  { method: "GET", path: "/v1/directory", operationId: "listDirectory" },
  { method: "PUT", path: "/v1/contacts/{handle}/rating", operationId: "rateAgent" },
  { method: "DELETE", path: "/v1/contacts/{handle}/rating", operationId: "deleteAgentRating" },
  { method: "GET", path: "/v1/contacts/{handle}/ratings", operationId: "listAgentRatings" },
];
const allowedOperationSignatures = [
  "DELETE /v1/agents/{handle}",
  "POST /v1/chats",
  "GET /v1/chats",
  "GET /v1/chats/{chatId}",
  "PUT /v1/chats/{chatId}",
  "POST /v1/chats/{chatId}/participants",
  "DELETE /v1/chats/{chatId}/participants",
  "POST /v1/chats/{chatId}/leave",
  "GET /v1/chats/{chatId}/activity",
  "PUT /v1/chats/{chatId}/activity",
  "DELETE /v1/chats/{chatId}/activity",
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
  "PUT /v1/messages/{messageId}/invoice",
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
  "POST /v1/contacts/lookup",
  "GET /v1/contact_card",
  "POST /v1/contact_card",
  "PATCH /v1/contact_card",
  "POST /v1/chats/{chatId}/calls",
  "GET /v1/chats/{chatId}/calls",
  "GET /v1/calls/{callId}",
  "POST /v1/calls/{callId}/end"
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
assert.equal(manifest.operation_count, 43);
assert.equal(manifest.path_count, 27);
assert.equal(manifest.source_path_count, 32);
assert.equal(manifest.source_schema_count, 161);
assert.equal(manifest.callback_count, 19);
assert.equal(new Set(operationJSON.map((operation) => operation.path)).size, 27);
assert.equal(operationJSON.length, 43);
assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 19);
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
]) {
  assert.equal(
    operationJSON.some((operation) => operation.path.includes(forbidden)),
    false,
    `unsupported path leaked into SDK: ${forbidden}`,
  );
}
assert.deepEqual(
  operationJSON.filter((operation) => /^\/v1\/contacts(?:\/|$)/u.test(operation.path)),
  [{ method: "POST", path: "/v1/contacts/lookup", operationId: "lookupContact" }],
  "Only the approved lookup operation may expose the Contacts route",
);
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
  "calls",
  "chats",
  "contactCard",
  "contacts",
  "messages",
  "webhookEvents",
  "webhookSubscriptions",
  "webhooks",
  "websocket",
]);
assert.equal("createAgent" in Relay, false);
assert.deepEqual(publicMethods(client.agents), ["delete"]);
assert.deepEqual(publicMethods(client.calls), [
  "create", "end", "list", "retrieve", "room",
]);
assert.deepEqual(publicMethods(client.chats), [
  "clearActivity",
  "create",
  "getActivity",
  "leaveChat",
  "listChats",
  "markAsRead",
  "retrieve",
  "sendVoicememo",
  "setActivity",
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
assert.deepEqual(publicMethods(client.contacts), ["lookup"]);
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
  assert.equal(document.paths["/v1/agents"], undefined);
  assert.equal(document.components.schemas.CreateAgentRequest, undefined);
  const schemas = document.components.schemas;
  const option = schemas.SelectionOption;
  assert.equal(option.additionalProperties, false);
  assert.deepEqual(option.required, ["value", "label"]);
  assert.equal(option.properties.value.maxLength, 100);
  assert.equal(option.properties.value.pattern, "^[A-Za-z0-9][A-Za-z0-9._:-]*$");
  assert.equal(option.properties.label.maxLength, 80);
  const selection = schemas.SelectionPart;
  assert.doesNotMatch(selection.description, /Coming soon/u);
  assert.doesNotMatch(selection.description, /Clear/u);
  assert.equal(selection.additionalProperties, false);
  assert.deepEqual(selection.required, ["type", "options"]);
  assert.deepEqual(selection.properties.type.enum, ["selection"]);
  assert.equal(selection.properties.options.minItems, 1);
  assert.equal(selection.properties.options.maxItems, 25);
  assert.equal(selection.properties.options.items.$ref, "#/components/schemas/SelectionOption");
  assert.equal(selection.properties.has_responded, undefined);
  assert.equal(schemas.SelectionPartResponse.properties.has_responded.readOnly, true);
  assert.equal(selection.properties.selected_values, undefined);
  assert.equal(schemas.SelectionPartResponse.properties.selected_values.readOnly, true);
  assert.deepEqual(schemas.SelectionPartResponse.properties.selected_values.type, ["array", "null"]);
  assert.ok(schemas.SelectionPartResponse.required.includes("selected_values"));
  assert.equal(schemas.SelectionPartResponse.properties.reactions.type, "null");
  const response = schemas.SelectionResponsePart;
  assert.equal(response.additionalProperties, false);
  assert.deepEqual(response.required, ["type", "selected_values"]);
  assert.deepEqual(response.properties.type.enum, ["selection_response"]);
  assert.equal(response.properties.selected_values.uniqueItems, true);
  assert.equal(response.properties.selected_values.minItems, 1);
  assert.equal(response.properties.selected_values.maxItems, 25);
  assert.equal(response.properties.selected_values.items.pattern, option.properties.value.pattern);
  assert.equal(response.properties.value, undefined, "metadata must not add visible fallback text");
  assert.match(response.description, /User-only metadata, exactly the second part after plain text/u);
  assert.match(response.description, /source-option order/u);
  assert.ok(response.description.includes("literal '• '"));
  assert.ok(response.description.includes("joined with '\\n'"));
  assert.match(response.description, /exact legacy source labels/u);
  assert.match(response.description, /arbitrary label parsing is never accepted/u);
  assert.match(response.description, /409\/1005/u);
  assert.deepEqual(schemas.SelectionResponsePartResponse.allOf, [{ $ref: "#/components/schemas/SelectionResponsePart" }]);
  for (const name of ["SelectionPart", "SelectionResponsePart", "ButtonsPart"]) {
    assert.ok(schemas.MessagePart.oneOf.some((part) => part.$ref === `#/components/schemas/${name}`));
  }
  assert.equal(schemas.MessagePart.discriminator.mapping.selection, "#/components/schemas/SelectionPart");
  assert.equal(schemas.MessagePart.discriminator.mapping.selection_response, "#/components/schemas/SelectionResponsePart");
  for (const name of ["Message", "MessageEvent", "SentMessage"]) {
    const refs = schemas[name].properties.parts.items.oneOf.map((part) => part.$ref);
    for (const part of ["SelectionPartResponse", "SelectionResponsePartResponse", "ButtonsPartResponse"]) {
      assert.ok(refs.includes(`#/components/schemas/${part}`), `${name} must carry ${part}`);
    }
  }
  assert.match(declaredTypes, /type: "selection"/u);
  assert.match(declaredTypes, /type: "selection_response"/u);
  assert.match(declaredTypes, /selected_values: string\[\]/u);

  assert.equal(document.components.schemas.CreateAgentResponse, undefined);
  assert.deepEqual(Object.keys(document.paths["/v1/agents/{handle}"]), ["delete"]);
  assert.equal(document.components.schemas.AgentImageRecipe.oneOf.length, 3);
  assert.deepEqual(document.components.schemas.AgentImageBackground.properties.linearGradient.properties.colors.enum, [
    ["EC8A3C", "C85F1C"], ["E0567A", "AD2A52"], ["D05FC6", "93217E"],
    ["8F6CF2", "5F38CF"], ["5B9BFA", "0B52C0"], ["2596A6", "116A79"], ["2FA46A", "137347"],
  ]);
  assert.equal(Object.hasOwn(document.components.schemas.ContactCardItem.properties, "id"), false);
  for (const name of [
    "ContactCardItem", "SetContactCardResponse", "UpdateContactCardRequest",
    "SetContactCardRequest", "ContactLookup",
  ]) {
    assert.equal(document.components.schemas[name].properties.message_requests_from, undefined);
  }
  assert.equal(document.paths["/v1/me"], undefined);
  assert.doesNotMatch(declaredTypes, /\bAgentMessageRequestsFrom\b|\bmessage_requests_from\??:/u);
  const deletion = document.paths["/v1/agents/{handle}"].delete;
  assert.equal(deletion.operationId, "deleteAgent");
  assert.equal(deletion.requestBody, undefined);
  assert.equal(deletion.responses["204"].content, undefined);
  for (const status of ["401", "403", "404", "409"]) assert.ok(deletion.responses[status]);
  const sourceOnly = new Set(sourceOnlyOperations.map((operation) => `${operation.method} ${operation.path}`));
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      // The public directory listing is deliberately unauthenticated on the
      // Server; this SDK carries no client for it yet, so it is not held to
      // the agent-token rule that every SDK operation satisfies.
      if (sourceOnly.has(`${method.toUpperCase()} ${path}`)) continue;
      assert.deepEqual(operation.security ?? document.security, [{ BearerAuth: [] }], `${method} ${path} still requires authentication`);
    }
  }
  const addParticipant = document.components.schemas.AddParticipantRequest;
  assert.deepEqual(addParticipant.required, ["handle"]);
  assert.deepEqual(Object.keys(addParticipant.properties).sort(), ["handle", "hide_history"]);
  assert.equal(addParticipant.properties.hide_history.type, "boolean");
  assert.equal(addParticipant.properties.hide_history.default, true);
  assert.match(declaredTypes, /hide_history\?: boolean/u);
  assert.doesNotMatch(declaredTypes, /\b(?:is_hidden|truncated_at|is_request|request_expires_at|request_sender_id)\??:/u);
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    for (const field of ["is_request", "request_expires_at", "request_sender_id"]) {
      assert.equal(field in (schema.properties ?? {}), false, `${name}.${field} is private`);
    }
  }
  const lookup = document.paths["/v1/contacts/lookup"];
  assert.deepEqual(Object.keys(lookup), ["post"]);
  assert.equal(lookup.post.operationId, "lookupContact");
  assert.equal(
    lookup.post.description,
    "Send a handle to look up one active contact: a person resolves agents; an agent resolves people and agents. Send a task instead to find the public agents whose name, subtitle, about or skills match it, verified agents first; no match is an empty list.",
  );
  // The lookup body is one of two closed shapes: the original handle lookup,
  // unchanged, or the task search the Server added with the agent directory.
  const lookupBody = lookup.post.requestBody.content["application/json"].schema;
  assert.equal(lookupBody.properties, undefined);
  assert.equal(lookupBody.oneOf.length, 2);
  const [lookupByHandle, lookupByTask] = lookupBody.oneOf;
  assert.deepEqual(lookupByHandle.required, ["handle"]);
  assert.deepEqual(Object.keys(lookupByHandle.properties), ["handle"]);
  assert.equal(lookupByHandle.additionalProperties, false);
  assert.equal(lookupByHandle.properties.handle.type, "string");
  assert.equal(lookupByHandle.properties.handle.minLength, 1);
  assert.equal(lookupByHandle.properties.handle.maxLength, 255);
  assert.deepEqual(lookupByTask.required, ["task"]);
  assert.deepEqual(Object.keys(lookupByTask.properties), ["task"]);
  assert.equal(lookupByTask.additionalProperties, false);
  assert.equal(lookupByTask.properties.task.type, "string");
  assert.equal(lookupByTask.properties.task.minLength, 1);
  assert.equal(lookupByTask.properties.task.maxLength, 200);
  // The 200 mirrors the request: one contact for a handle, a bounded list for
  // a task. The handle branch keeps the single `contact` it always carried.
  const lookupOK = lookup.post.responses["200"].content["application/json"].schema;
  assert.equal(lookupOK.properties, undefined);
  assert.equal(lookupOK.oneOf.length, 2);
  const [lookupOneContact, lookupManyContacts] = lookupOK.oneOf;
  assert.deepEqual(lookupOneContact.required, ["contact"]);
  assert.deepEqual(Object.keys(lookupOneContact.properties), ["contact"]);
  assert.equal(lookupOneContact.additionalProperties, false);
  assert.equal(lookupOneContact.properties.contact.$ref, "#/components/schemas/ContactLookup");
  assert.deepEqual(lookupManyContacts.required, ["contacts"]);
  assert.deepEqual(Object.keys(lookupManyContacts.properties), ["contacts"]);
  assert.equal(lookupManyContacts.additionalProperties, false);
  assert.equal(lookupManyContacts.properties.contacts.type, "array");
  assert.equal(lookupManyContacts.properties.contacts.maxItems, 20);
  assert.equal(
    lookupManyContacts.properties.contacts.items.$ref,
    "#/components/schemas/ContactLookup",
  );
  const contactLookup = document.components.schemas.ContactLookup;
  assert.deepEqual(contactLookup.required, [
    "id", "handle", "display_name", "kind", "image_url", "image_color", "verified",
  ]);
  // `about` left the required set and joined the agent-only profile fields the
  // directory carry added; every property is still one of the two lists.
  assert.deepEqual(Object.keys(contactLookup.properties), [
    ...contactLookup.required,
    "name", "subtitle", "about", "category", "skills", "visibility",
  ]);
  assert.equal(contactLookup.additionalProperties, false);
  assert.deepEqual(contactLookup.properties.kind.enum, ["user", "agent"]);
  assert.equal(
    document.components.schemas.ChatHandle.properties.is_contact.description,
    "Whether the caller holds this member as a Contact. A person's reply "
      + "or adding the agent makes it a Contact. Removing a Contact keeps "
      + "an existing conversation in Chats until another incoming message "
      + "makes it a message request.",
  );
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
  // Calls use one signaling-only WebSocket room. The retired REST media and
  // connection APIs stay gone; media itself remains WebRTC.
  for (const gone of [
    "CallOffer", "CallAnswer", "CallAudioFormat", "CallConnectionRequest",
    "CallConnectionResult", "CallSubscribeResult", "CallRenegotiateRequest",
  ]) {
    assert.equal(gone in document.components.schemas, false, `${gone} is obsolete`);
  }
  for (const gone of ["connected", "connections", "media", "accept", "decline"]) {
    assert.equal(`/v1/calls/{callId}/${gone}` in document.paths, false, `${gone} REST route is obsolete`);
  }
  assert.equal(document.paths["/v1/calls/{callId}/room"].get.operationId, "connectCallRoom");
  assert.deepEqual(document.components.schemas.CallRoomPublishOfferFrame.properties.tracks.items.properties.name.enum, ["audio", "video"]);
  assert.deepEqual(document.components.schemas.CallRoomSubscriptionOfferFrame.properties.track.enum, ["audio", "video"]);
  assert.equal(document.components.schemas.CallRoomStateFrame.properties.participants.minItems, 2);
  assert.equal(document.components.schemas.CallRoomStateFrame.properties.participants.maxItems, 2);
  assert.equal("call_url" in document.components.schemas.SetContactCardResponse.properties, false);
  assert.equal("call_url" in document.components.schemas.UpdateContactCardRequest.properties, false);
  // Call status remains a small Relay lifecycle vocabulary; there is no queued state.
  const callStatus = ["ringing", "in-progress", "completed", "no-answer", "canceled", "busy", "failed"];
  assert.deepEqual(document.components.schemas.Call.properties.status.enum, callStatus);
  assert.equal("connected_at" in document.components.schemas.Call.properties, false);
  assert.equal("end_reason" in document.components.schemas.Call.properties, false);
  assert.equal(document.components.schemas.Call.required.includes("end_reason"), false);
  assert.ok(document.components.schemas.SystemEvent.required.includes("call"));
  assert.ok(document.components.schemas.SystemEvent.properties.type.enum.includes("call"));
  assert.equal(document.components.schemas.SystemEvent.properties.type.enum.includes("call_ended"), false);
  assert.deepEqual(document.components.schemas.CallMarker.required, [
    "id", "status", "answered_at", "ended_at", "from", "to",
    "duration_seconds",
  ]);
  assert.deepEqual(document.components.schemas.CallMarker.properties.status.enum, callStatus);
  for (const gone of ["end_reason", "connected"]) {
    assert.equal(gone in document.components.schemas.CallMarker.properties, false, `CallMarker.${gone} is obsolete`);
  }
  assert.equal(document.components.schemas.CallCreateRequest.properties.to.minItems, 1);
  assert.equal(document.components.schemas.CallCreateRequest.properties.to.maxItems, 1);
  for (const [event, name] of [
    ["call.created", "CallCreatedWebhook"],
    ["call.updated", "CallUpdatedWebhook"],
    ["call.ended", "CallEndedWebhook"],
  ]) {
    assert.equal(
      document["x-relay-webhooks"][`${event}.v2026-08-30`].post
        .requestBody.content["application/json"].schema.$ref,
      `#/components/schemas/${name}`,
    );
  }
  assert.equal(operationJSON.some((o) => o.path === "/v1/calls/{callId}/media"), false);
  assert.equal(operationJSON.some((o) => o.path === "/v1/calls/{callId}/room"), false);
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
      "image_color",
      // Server 56f31c1 renamed ChatHandle.about to subtitle.
      "subtitle",
      "verified",
      "is_contact",
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
      "image_color",
      "subtitle",
      "verified",
      "is_contact",
      "activity_version",
      "activity",
    ],
  );
  const activityPath = document.paths["/v1/chats/{chatId}/activity"];
  assert.deepEqual(Object.keys(activityPath), ["parameters", "get", "put", "delete"]);
  assert.equal(activityPath.get.operationId, "getActivity");
  assert.equal(activityPath.put.operationId, "setActivity");
  assert.equal(activityPath.delete.operationId, "clearActivity");
  assert.equal(activityPath.delete.parameters[0].name, "activity_id");
  assert.equal(activityPath.delete.parameters[0].in, "query");
  assert.equal(activityPath.delete.parameters[0].required, false);
  assert.ok(activityPath.delete.responses["204"]);
  assert.ok(activityPath.put.responses["409"]);
  assert.equal(activityPath.put.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/SetActivityRequest");
  for (const method of ["get", "put"]) {
    assert.equal(activityPath[method].responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/ChatActivityState");
  }
  const activityInput = document.components.schemas.SetActivityRequest;
  assert.deepEqual(activityInput.required, ["text"]);
  assert.equal(activityInput.additionalProperties, false);
  assert.equal(activityInput.properties.text["x-max-graphemes"], 21);
  assert.equal(activityInput.properties.text["x-max-utf8-bytes"], 1024);
  assert.deepEqual(activityInput.properties.emoji.type, ["string", "null"]);
  assert.equal(activityInput.properties.activity_id.format, "uuid");
  assert.deepEqual(document.components.schemas.ChatActivity.required,
    ["id", "text", "emoji", "updated_at", "expires_at"]);
  assert.deepEqual(document.components.schemas.ChatActivityState.required,
    ["chat_id", "agent_id", "version", "activity"]);
  assert.equal(document.components.schemas.ChatActivityState.properties.version.type, "string");
  assert.deepEqual(document.components.schemas.ChatActivityState.properties.activity.anyOf,
    [{ $ref: "#/components/schemas/ChatActivity" }, { type: "null" }]);
  assert.equal(document.components.schemas.ChatHandle.properties.activity_version.type, "string");
  assert.equal(RELAY_WEBHOOK_EVENT_TYPES.includes("chat.activity.updated"), false);
  assert.equal(Object.keys(document["x-relay-webhooks"]).some((name) => name.startsWith("chat.activity.")), false);
  for (const type of ["ChatActivity", "ChatActivityResponse", "ChatSetActivityParams", "ChatClearActivityParams"]) {
    assert.ok(declaredTypes.includes(`export interface ${type} `), `Missing SDK ${type}`);
  }
  assert.equal(
    document.components.schemas.ChatHandle.properties.subtitle.maxLength,
    60,
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.image_url.description,
    "Current Contact picture, as a permanent address served by Relay. It does not expire and may be cached indefinitely.",
  );
  assert.equal(
    document.components.schemas.ChatHandle.properties.subtitle.description,
    "The one line under an agent's name. User Contacts return null.",
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
let provenanceChecked = false;
if (!structuralOnly) {
  assert.notEqual(manifest.upstream.publication_status, "local-only",
    "Release provenance blocked: candidate Server commit is local-only; use --structural for candidate validation, then pin publicly available matching bytes before release.");
  assert.equal(skillLock.api.openapi_sha256, manifest.source_openapi_sha256,
    "Release provenance blocked: historical published skill contract differs from the workspace candidate.");
  assert.match(
    manifest.upstream.commit,
    /^[a-f0-9]{40}$/u,
    "Server contract pin is pending. Pin the actual commit carrying these bytes; never substitute current HEAD.",
  );
  assert.match(
    pinned.commit,
    /^[a-f0-9]{40}$/u,
    "Public SDK contract pin is pending. Pin a durable public commit carrying these bytes.",
  );
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
  provenanceChecked = durability.checked;
} else {
  console.warn("Source-only contract checks: Server/public SDK commit provenance was NOT checked.");
}

console.log(JSON.stringify({
  ok: true,
  provenance_checked: provenanceChecked,
  package: "@relaymessenger/sdk",
  paths: manifest.path_count,
  operations: operationJSON.length,
  source_schemas: manifest.source_schema_count,
  callbacks: manifest.callback_count,
  openapi_sha256: manifest.source_openapi_sha256,
  source_commit: manifest.upstream.commit,
  transport_decision_sha256: manifest.transport_decision.sha256,
}));
