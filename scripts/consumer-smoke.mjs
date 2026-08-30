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
const release = resolve(root, ".release-tmp");
const pack = resolve(release, "pack");
rmSync(release, { recursive: true, force: true });
mkdirSync(pack, { recursive: true });

let consumer;
try {
  execFileSync("npm", [
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
  execFileSync("npm", [
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
    "avatar_url",
  ]);
  assert.deepEqual(interfaceFields("UserChatHandle"), [
    "kind",
    "greeting_message",
  ]);
  assert.deepEqual(interfaceFields("AgentChatHandle"), [
    "kind",
    "greeting_message",
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
      assert.equal(packageJSON.version, "0.1.0");
      assert.equal(RELAY_V1_OPERATIONS.length, 33);
      assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 13);
      const allowedOperations = new Set([
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
      assert.deepEqual(methods(client.chats), [
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
      assert.deepEqual(methods(client.messages), [
        "addReaction",
        "create",
        "listMessagesThread",
        "retrieve",
      ]);
      assert.deepEqual(methods(client.chats.messages), ["list", "send"]);
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
    `,
  ], { cwd: consumer, stdio: "inherit" });
  console.log(JSON.stringify({
    ok: true,
    tarball: tarballs[0],
    package: "@relaymessenger/sdk@0.1.0",
  }));
} finally {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
}
