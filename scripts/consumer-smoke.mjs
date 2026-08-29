import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
      assert.equal(RELAY_V1_OPERATIONS.length, 36);
      assert.equal(RELAY_WEBHOOK_EVENT_TYPES.length, 13);
      const client = new Relay({
        apiKey: "consumer-test",
        fetch: async () => new Response("{}", { status: 200 }),
      });
      assert.equal(typeof client.chats.messages.send, "function");
      assert.equal(typeof client.chats.startTyping, "function");
      assert.equal(typeof client.chats.stopTyping, "function");
      assert.equal(typeof client.chats.shareContactCard, "function");
      assert.equal(typeof client.webhooks.unwrap, "function");
      assert.equal(typeof client.websocket.run, "function");
      assert.equal("createConnection" in client.websocket, false);
      assert.equal(typeof client.blockedHandles.block, "function");
      assert.equal("socketMode" in client, false);
      assert.equal("contacts" in client, false);
      for (const key of ["pollEvents", "realtime", "responding", "typing"]) {
        assert.equal(key in client, false);
        assert.equal(key in client.chats, false);
        assert.equal(key in client.messages, false);
      }
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
