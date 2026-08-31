import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const targetArgument = valueAfter("--package");
const expectedVersion = valueAfter("--expected-version");
const receiptPath = valueAfter("--receipt");
const tarballArgument = valueAfter("--tarball");

if (!targetArgument || !expectedVersion) {
  throw new Error(
    "Usage: node scripts/package-proof.mjs --package <spec-or-tarball> "
      + "--expected-version <version> [--tarball <tarball>] "
      + "[--receipt <path>]",
  );
}

const target = targetArgument.endsWith(".tgz")
  ? resolve(targetArgument)
  : targetArgument;
const tarball = tarballArgument
  ? resolve(tarballArgument)
  : targetArgument.endsWith(".tgz")
    ? target
    : undefined;

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const consumer = mkdtempSync(resolve(tmpdir(), "relay-sdk-package-proof-"));
const checks = [];

const record = (name) => checks.push(name);

const inspectTarball = () => {
  if (!tarball) return undefined;
  const entries = execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean).sort();

  const required = [
    "package/LICENSE",
    "package/NOTICE",
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/webhooks.d.ts",
    "package/dist/webhooks.js",
    "package/dist/websocket.d.ts",
    "package/dist/websocket.js",
    "package/package.json",
  ];
  for (const entry of required) {
    assert.ok(entries.includes(entry), `Packed package is missing ${entry}`);
  }
  for (const entry of entries) {
    assert.match(
      entry,
      /^package\/(?:LICENSE|NOTICE|README\.md|package\.json|LICENSES\/[^/]+|dist\/[^/]+)$/,
      `Unexpected packed path: ${entry}`,
    );
    assert.doesNotMatch(
      entry,
      /(?:^|\/)(?:src|test|tests|\.github|\.env|\.npmrc|node_modules)(?:\/|$)/,
      `Private or repository-only path was packed: ${entry}`,
    );
  }
  record("pack_contents");
  const bytes = readFileSync(tarball);
  return {
    filename: basename(tarball),
    files: entries.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${
      createHash("sha512").update(bytes).digest("base64")
    }`,
  };
};

let result;
try {
  const tarballProof = inspectTarball();
  writeFileSync(resolve(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }));
  execFileSync(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    target,
    "typescript@5.9.3",
    "@types/node@22",
    "@types/ws@8",
  ], { cwd: consumer, stdio: "inherit" });

  const installedManifest = JSON.parse(readFileSync(
    resolve(
      consumer,
      "node_modules",
      "@relaymessenger",
      "sdk",
      "package.json",
    ),
    "utf8",
  ));
  assert.equal(installedManifest.name, "@relaymessenger/sdk");
  assert.equal(installedManifest.version, expectedVersion);
  assert.deepEqual(installedManifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
    tag: "staging",
  });
  record("installed_identity");

  writeFileSync(resolve(consumer, "runtime.mjs"), `
    import assert from "node:assert/strict";
    import { createHmac } from "node:crypto";
    import Relay, * as sdk from "@relaymessenger/sdk";
    import packageJSON from "@relaymessenger/sdk/package.json" with { type: "json" };

    assert.equal(packageJSON.version, ${JSON.stringify(expectedVersion)});
    assert.deepEqual(Object.keys(sdk).sort(), [
      "Attachments",
      "BlockedHandles",
      "Chats",
      "ChatsPage",
      "ContactCard",
      "ContactRequests",
      "Messages",
      "MessagesPage",
      "RELAY_V1_OPERATIONS",
      "RELAY_WEBHOOK_EVENT_TYPES",
      "Relay",
      "RelayAPIError",
      "RelayPage",
      "RelayWebhookConfiguredError",
      "WebhookEvents",
      "WebhookSubscriptions",
      "WebhookVerificationError",
      "WebSocket",
      "Webhooks",
      "default",
      "runWebSocket",
      "verifyWebhookSignature",
    ].sort());
    for (const privateName of [
      "Contacts",
      "InternalRequest",
      "Transport",
      "createConnectionTicket",
      "isDefault",
      "pollEvents",
      "socketMode",
    ]) {
      assert.equal(privateName in sdk, false, privateName + " must stay private");
    }
    for (const operation of sdk.RELAY_V1_OPERATIONS) {
      assert.equal(
        ["/v1/me/", "/v1/client/", "/v1/console/", "/v1/internal/", "/api/auth/"]
          .some((prefix) => operation.path.startsWith(prefix)),
        false,
        operation.path + " is not a developer API route",
      );
    }

    const requests = [];
    const relay = new Relay({
      apiKey: "package-proof-token",
      baseURL: "https://api.staging.relayapp.im/",
      maxRetries: 0,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        requests.push({
          url: url.toString(),
          method: init?.method,
          authorization: headers.get("authorization"),
          idempotencyKey: headers.get("idempotency-key"),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.pathname === "/v1/chats") {
          return Response.json({ chats: [], next_cursor: null });
        }
        if (url.pathname === "/v1/contact_requests") {
          return Response.json({ state: "pending" }, { status: 201 });
        }
        return Response.json({ accepted: true }, { status: 202 });
      },
    });
    const page = await relay.chats.listChats({ limit: 1 });
    assert.deepEqual(page.chats, []);
    await relay.messages.create({
      to: ["alice"],
      message: {
        parts: [{ type: "text", value: "Hello" }],
        idempotency_key: "package-proof-message",
      },
    });
    assert.deepEqual(
      await relay.contactRequests.create({
        handle: "advait",
        "Idempotency-Key": "package-proof-contact-request",
      }),
      { state: "pending" },
    );
    assert.deepEqual(requests, [
      {
        url: "https://api.staging.relayapp.im/v1/chats?limit=1",
        method: "GET",
        authorization: "Bearer package-proof-token",
        idempotencyKey: null,
        body: null,
      },
      {
        url: "https://api.staging.relayapp.im/v1/messages",
        method: "POST",
        authorization: "Bearer package-proof-token",
        idempotencyKey: "package-proof-message",
        body: {
          to: ["alice"],
          message: {
            parts: [{ type: "text", value: "Hello" }],
            idempotency_key: "package-proof-message",
          },
        },
      },
      {
        url: "https://api.staging.relayapp.im/v1/contact_requests",
        method: "POST",
        authorization: "Bearer package-proof-token",
        idempotencyKey: "package-proof-contact-request",
        body: {
          handle: "advait",
        },
      },
    ]);

    const webhookSecretBytes = Buffer.alloc(32, 7);
    const webhookSecret = "whsec_" + webhookSecretBytes.toString("base64");
    const webhookID = "01993d50-b4ce-71e6-8e65-35d325d95ddb";
    const timestamp = Math.floor(Date.now() / 1000);
    const event = {
      api_version: "v1",
      webhook_version: "2026-02-03",
      event_type: "message.received",
      event_id: webhookID,
      created_at: new Date(timestamp * 1000).toISOString(),
      trace_id: "package-proof-trace",
      agent_id: "01993d50-b4ce-71e6-8e65-35d325d95dde",
      data: { id: "message" },
    };
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", webhookSecretBytes)
      .update(webhookID + "." + timestamp + "." + body)
      .digest("base64");
    const headers = {
      "webhook-id": webhookID,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": "v1," + signature,
    };
    sdk.verifyWebhookSignature(webhookSecret, body, headers);
    assert.deepEqual(
      new Relay({
        apiKey: "package-proof-token",
        webhookSecret,
      }).webhooks.unwrap(body, { headers }),
      event,
    );

    assert.equal(typeof sdk.runWebSocket, "function");
    assert.equal(typeof relay.websocket.run, "function");
    assert.equal("createConnection" in relay.websocket, false);
    assert.equal("retrieve" in relay.websocket, false);
    assert.equal("update" in relay.websocket, false);
  `);
  execFileSync(process.execPath, [resolve(consumer, "runtime.mjs")], {
    cwd: consumer,
    stdio: "inherit",
  });
  record("esm_import");
  record("rest_client");
  record("webhook_verifier");
  record("websocket_exports");
  record("private_api_boundary");

  writeFileSync(resolve(consumer, "consumer.ts"), `
    import Relay, {
      runWebSocket,
      verifyWebhookSignature,
      type RelayWebhookEnvelope,
      type ContactAddedWebhookEvent,
      type ContactRemovedWebhookEvent,
      type WebSocketRunOptions,
    } from "@relaymessenger/sdk";

    const relay = new Relay({ apiKey: "type-proof" });
    const options: WebSocketRunOptions = {
      onEvent: async (_event, { sequence }) => {
        sequence satisfies string;
      },
      onFullSync: async ({ throughSequence }) => {
        throughSequence satisfies string;
      },
    };
    void relay.websocket.run(options);
    runWebSocket satisfies Function;
    verifyWebhookSignature satisfies Function;
    declare const envelope: RelayWebhookEnvelope;
    envelope.agent_id satisfies string;
    declare const added: ContactAddedWebhookEvent;
    added.data.chat_id satisfies string;
    declare const removed: ContactRemovedWebhookEvent;
    removed.data.contact.handle satisfies string;
    void relay.contactRequests.create({ handle: "advait" });
    // @ts-expect-error user Contact request listing is private.
    relay.contactRequests.list();
    // @ts-expect-error polling is not part of Relay.
    relay.pollEvents();
    // @ts-expect-error private user routes are not SDK resources.
    relay.users;
    // @ts-expect-error default-agent state is private.
    relay.isDefault;
  `);
  writeFileSync(resolve(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["consumer.ts"],
  }));
  const tsc = resolve(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  execFileSync(tsc, ["-p", "tsconfig.json"], {
    cwd: consumer,
    stdio: "inherit",
  });
  record("typescript_consumer");

  result = {
    schema: "relay-sdk-package-proof/v1",
    ok: true,
    package: `@relaymessenger/sdk@${expectedVersion}`,
    source: tarball ? "tarball" : "registry",
    requested: targetArgument,
    resolved_version: installedManifest.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    checks,
    ...(tarballProof ? { tarball: tarballProof } : {}),
    proved_at: new Date().toISOString(),
  };
  if (receiptPath) {
    const absoluteReceipt = resolve(receiptPath);
    mkdirSync(resolve(absoluteReceipt, ".."), { recursive: true });
    writeFileSync(absoluteReceipt, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result));
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
