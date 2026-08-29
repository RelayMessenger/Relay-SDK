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
assert.equal(new Set(operationJSON.map((operation) => operation.path)).size, 23);
assert.equal(operationJSON.length, 36);
assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 11);

for (const forbidden of [
  "/v1/events",
  "/typing",
  "/realtime",
  "/responding",
  "/api/partner",
  "/api/mobile",
]) {
  assert.equal(
    operationJSON.some((operation) => operation.path.includes(forbidden)),
    false,
    `unsupported path leaked into SDK: ${forbidden}`,
  );
}
assert.ok(operationJSON.some((operation) =>
  operation.path === "/v1/messages/{messageId}/delivered"));

const client = new Relay({
  apiKey: "contract-check",
  fetch: async () => new Response("{}", { status: 200 }),
});
for (const forbidden of ["pollEvents", "poll", "realtime", "responding", "typing"]) {
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
  assert.equal(Object.keys(document.paths).length, 23);
  assert.equal(Object.keys(document.components.schemas).length, 94);
  assert.deepEqual(sourceOperations, manifest.operations);
  assert.equal(Object.keys(document["x-relay-webhooks"]).length, 11);
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
    ["sent", "delivered", "received", "read"],
  );
  for (const [schema, fields] of Object.entries({
    Chat: ["health_status", "is_archived"],
    Reaction: ["sticker"],
    SendMessageResult: ["from_selection", "previous_chat_id"],
    Message: ["reconciled_at", "effect", "service"],
    ChatInfo: ["is_active"],
  })) {
    const properties = document.components.schemas[schema].properties;
    for (const field of fields) {
      assert.equal(field in properties, false, `${schema}.${field} is obsolete`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  package: "@relayapp/sdk",
  paths: 23,
  operations: 36,
  callbacks: 11,
  openapi_sha256: manifest.sha256,
}));
