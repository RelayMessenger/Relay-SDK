import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  readFileSync(resolve(root, "packages", "sdk", "package.json"), "utf8"),
);
const release = resolve(root, ".release-tmp");
const pack = resolve(release, "pack");
rmSync(release, { recursive: true, force: true });
mkdirSync(pack, { recursive: true });

const runNpm = (args, options) => {
  const windows = process.platform === "win32";
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  return execFileSync(windows ? "npm.cmd" : "npm", windows ? args.map(quote) : args, {
    ...options, shell: windows, windowsHide: true,
  });
};

let consumer;
try {
  runNpm([
    "pack",
    "--workspace",
    "@relaymessenger/sdk",
    "--ignore-scripts",
    "--pack-destination",
    pack,
  ], { cwd: root, stdio: "ignore" });
  const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = resolve(pack, tarballs[0]);

  consumer = mkdtempSync(resolve(tmpdir(), "relay-sdk-consumer-"));
  writeFileSync(resolve(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }));
  runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], { cwd: consumer, stdio: "ignore" });
  const packedTypes = readFileSync(
    resolve(
      consumer,
      "node_modules",
      "@relaymessenger",
      "sdk",
      "dist",
      "types.d.ts",
    ),
    "utf8",
  );
  const declarations = ts.createSourceFile(
    "types.d.ts",
    packedTypes,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const interfaceFields = (name) => {
    const declaration = declarations.statements.find(
      (statement) =>
        ts.isInterfaceDeclaration(statement)
        && statement.name.text === name,
    );
    assert.ok(declaration, `${name} must exist in the packed declarations`);
    return declaration.members.map((member) => {
      assert.ok(member.name, `${name} members must be named`);
      return member.name.getText(declarations);
    });
  };
  assert.deepEqual(interfaceFields("ChatHandleBase"), [
    "id",
    "handle",
    "status",
    "joined_at",
    "left_at",
    "is_me",
    "display_name",
    "image_url",
    "subtitle",
    "verified",
    "is_contact",
    "activity_version",
    "activity",
  ]);
  assert.deepEqual(interfaceFields("UserChatHandle"), [
    "kind",
  ]);
  assert.deepEqual(interfaceFields("AgentChatHandle"), [
    "kind",
  ]);
  assert.deepEqual(interfaceFields("ChatActivity"), [
    "id", "text", "emoji", "updated_at", "expires_at",
  ]);
  assert.deepEqual(interfaceFields("ChatActivityResponse"), [
    "chat_id", "agent_id", "version", "activity",
  ]);
  assert.deepEqual(interfaceFields("ChatSetActivityParams"), [
    "text", "emoji", "activity_id",
  ]);
  assert.deepEqual(interfaceFields("ChatClearActivityParams"), ["activity_id"]);
  assert.doesNotMatch(packedTypes, /\bavatar_url\b/u);
  assert.doesNotMatch(packedTypes, /\btagline\b/u);
  assert.doesNotMatch(packedTypes, /\b(?:is_request|request_expires_at|request_sender_id)\??:/u);
  assert.deepEqual(interfaceFields("ContactLookup"), [
    "id", "handle", "display_name", "kind", "image_url", "image_color", "verified",
    "name", "subtitle", "description", "category", "skills", "visibility", "creator",
  ]);
  for (const name of ["ContactCardItem", "ContactCardUpdateParams", "ContactCardCreateParams"]) {
    assert.equal(interfaceFields(name).includes("message_requests_from"), false);
  }
  assert.doesNotMatch(packedTypes, /\bAgentMessageRequestsFrom\b|\bmessage_requests_from\??:/u);
  assert.doesNotMatch(packedTypes, /AgentCreate(?:ProfileParams|Params|Response)/);
  assert.doesNotMatch(packedTypes, /\bContactRequestCreate(?:Params|Response)\b/u);
  assert.deepEqual(interfaceFields("MessageContent"), [
    "parts",
    "reply_to",
    "idempotency_key",
    "silent",
  ]);
  assert.deepEqual(interfaceFields("MessageCreateParams"), [
    "to",
    "message",
    "\"Idempotency-Key\"",
  ]);
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import assert from "node:assert/strict";
      import Relay, {
        RELAY_V1_OPERATIONS,
        RELAY_WEBHOOK_EVENT_TYPES,
      } from "@relaymessenger/sdk";
      import packageJSON from "@relaymessenger/sdk/package.json" with { type: "json" };
      assert.equal(packageJSON.name, "@relaymessenger/sdk");
      assert.equal(packageJSON.version, ${JSON.stringify(packageManifest.version)});
      assert.equal(RELAY_V1_OPERATIONS.length, 48);
      assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 24);
      const allowedOperations = new Set([
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
        "POST /v1/chats/{chatId}/location/request",
        "GET /v1/chats/{chatId}/location",
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
        "POST /v1/payment_requests",
        "GET /v1/payment_requests",
        "GET /v1/payment_requests/{paymentRequestId}",
        "POST /v1/payment_requests/{paymentRequestId}/cancel",
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
        "DELETE /v1/agents/{handle}",
        "POST /v1/chats/{chatId}/calls",
        "GET /v1/chats/{chatId}/calls",
        "GET /v1/calls/{callId}",
        "POST /v1/calls/{callId}/end",
      ]);
      assert.deepEqual(
        new Set(RELAY_V1_OPERATIONS.map(
          ({ method, path }) => method + " " + path,
        )),
        allowedOperations,
      );
      for (const prefix of [
        "/v1/me/",
        "/v1/client/",
        "/v1/console/",
        "/v1/internal/",
        "/api/auth/",
      ]) {
        assert.equal(
          RELAY_V1_OPERATIONS.some(({ path }) => path.startsWith(prefix)),
          false,
        );
      }
      assert.equal(
        RELAY_V1_OPERATIONS.some(
          ({ operationId }) =>
            operationId === "acknowledgeMessageDelivered",
        ),
        false,
      );
      const client = new Relay({
        apiKey: "consumer-test",
        fetch: async () => new Response("{}", { status: 200 }),
      });
      const methods = (value) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(value))
          .filter((name) => name !== "constructor")
          .sort();
      assert.equal("createAgent" in Relay, false);
      assert.deepEqual(methods(client.agents), ["delete"]);
      assert.deepEqual(methods(client.contacts), ["lookup"]);
      assert.deepEqual(methods(client.chats), [
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
      assert.deepEqual(methods(client.messages), [
        "addReaction",
        "create",
        "listMessagesThread",
        "retrieve",
      ]);
      assert.deepEqual(methods(client.chats.messages), ["list", "send"]);
      assert.deepEqual(methods(client.chats.location), ["request", "retrieve"]);
      assert.deepEqual(methods(client.paymentRequests), [
        "cancel",
        "create",
        "list",
        "retrieve",
      ]);
      assert.deepEqual(
        methods(client.chats.participants),
        ["add", "remove"],
      );
      assert.deepEqual(methods(client.attachments), [
        "create",
        "delete",
        "retrieve",
        "upload",
      ]);
      assert.deepEqual(methods(client.webhookEvents), ["list"]);
      assert.deepEqual(methods(client.webhookSubscriptions), [
        "create",
        "delete",
        "list",
        "retrieve",
        "update",
      ]);
      assert.deepEqual(methods(client.contactCard), [
        "create",
        "retrieve",
        "update",
      ]);
      assert.deepEqual(methods(client.blockedHandles), [
        "block",
        "list",
        "unblock",
      ]);
      assert.deepEqual(methods(client.websocket), ["run"]);
      assert.deepEqual(methods(client.webhooks), ["unwrap", "verify"]);
      const activityRequests = [];
      const activityState = {
        chat_id: "chat", agent_id: "agent", version: "9007199254740993",
        activity: { id: "task", text: "Generating image", emoji: "🖼️",
          updated_at: "2026-09-20T12:00:00Z", expires_at: "2026-09-20T12:01:30Z" },
      };
      const activityClient = new Relay({
        apiKey: "consumer-test",
        fetch: async (url, init) => {
          activityRequests.push({ url: String(url), init });
          return init.method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json(activityState);
        },
      });
      const started = await activityClient.chats.setActivity("chat/one", {
        text: "Generating image", emoji: "🖼️",
      });
      assert.deepEqual(started, activityState);
      assert.deepEqual(await activityClient.chats.getActivity("chat/one"), activityState);
      await activityClient.chats.clearActivity("chat/one", { activity_id: started.activity.id });
      assert.deepEqual(activityRequests.map(({ init }) => init.method), ["PUT", "GET", "DELETE"]);
      assert.equal(new URL(activityRequests[0].url).pathname, "/v1/chats/chat%2Fone/activity");
      assert.equal(new URL(activityRequests[2].url).searchParams.get("activity_id"), "task");
      assert.equal(activityRequests[2].init.body, undefined);
      assert.equal(RELAY_WEBHOOK_EVENT_TYPES.includes("chat.activity.updated"), false);
    `,
  ], { cwd: consumer, stdio: "inherit" });

  // `@relaymessenger/sdk/calls`: the WebRTC packages are optional peer
  // dependencies (ws's bufferutil/utf-8-validate pattern), so the install
  // above brought none of them and the root entry loaded without them. The
  // subpath loads once the consumer installs them.
  const callsPeers = Object.keys(packageManifest.peerDependenciesMeta ?? {});
  for (const peer of ["werift", "@evan/opus", "rtp-packet"]) {
    assert.equal(callsPeers.includes(peer), true, `${peer} is not an optional peer`);
    assert.throws(
      () => readFileSync(resolve(consumer, "node_modules", ...peer.split("/"), "package.json")),
      `${peer} was installed without being asked for`,
    );
  }
  runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...["werift", "@evan/opus", "rtp-packet"].map(
      (peer) => `${peer}@${packageManifest.peerDependencies[peer]}`,
    ),
  ], { cwd: consumer, stdio: "ignore" });
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import assert from "node:assert/strict";
      import {
        RelayCallTransport,
        RelayCallTransportError,
        VideoFrame,
        VideoSource,
        VideoStream,
        createWeriftWebRTCFactory,
      } from "@relaymessenger/sdk/calls";
      for (const value of [RelayCallTransport, RelayCallTransportError, VideoFrame, VideoSource, VideoStream]) {
        assert.equal(typeof value, "function");
      }
      const factory = createWeriftWebRTCFactory();
      assert.equal(typeof factory.createPeerConnection, "function");
      assert.equal(typeof factory.createVideoSender, "function");
    `,
  ], { cwd: consumer, stdio: "inherit" });
  console.log(JSON.stringify({
    ok: true,
    tarball: tarballs[0],
    package: `@relaymessenger/sdk@${packageManifest.version}`,
  }));
} finally {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
}
