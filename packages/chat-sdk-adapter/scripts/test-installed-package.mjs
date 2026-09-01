import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const artifacts = resolve(root, ".artifacts");
const packDir = resolve(artifacts, "pack");
const consumer = resolve(artifacts, "installed-consumer");

rmSync(artifacts, { force: true, recursive: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(consumer, { recursive: true });

execFileSync(
  "npm",
  [
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ],
  { cwd: root, stdio: "inherit" },
);

const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const tarball = resolve(
  packDir,
  `${manifest.name
    .replace(/^@/, "")
    .replaceAll("/", "-")}-${manifest.version}.tgz`,
);
const contents = execFileSync("tar", ["-tzf", tarball], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .sort();

for (const required of [
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/package.json",
]) {
  if (!contents.includes(required)) {
    throw new Error(`packed tarball is missing ${required}`);
  }
}
for (const forbidden of [
  "package/src/",
  "package/test/",
  "package/contracts/",
  "package/.env",
]) {
  if (contents.some((entry) => entry.startsWith(forbidden))) {
    throw new Error(`packed tarball contains forbidden path ${forbidden}`);
  }
}

writeFileSync(
  resolve(consumer, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: {
        "@relaymessenger/chat-sdk-adapter": `file:${tarball}`,
        chat: "4.39.0",
        typescript: "7.0.2",
      },
    },
    null,
    2,
  ),
);

execFileSync(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: consumer, stdio: "inherit" },
);

writeFileSync(
  resolve(consumer, "smoke.mjs"),
  `
import assert from "node:assert/strict";
import {
  RELAY_WEBHOOK_VERSION,
  createRelayAdapter,
} from "@relaymessenger/chat-sdk-adapter";

const chatId = "11111111-1111-4111-8111-111111111111";
let resolverCalls = 0;
const adapter = createRelayAdapter({
  idempotencyKeyResolver: () => "installed-smoke",
  token: async () => {
    resolverCalls += 1;
    return "installed-token";
  },
  typing: false,
  fetch: async (_url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer installed-token");
    return Response.json({
      chat_id: chatId,
      message: {
        id: "22222222-2222-4222-8222-222222222222",
        parts: [{ type: "text", value: "installed" }],
        created_at: "2026-08-30T00:00:00.000Z",
        sent_at: null,
        delivery_status: "sent"
      }
    }, { status: 202 });
  }
});
assert.equal(adapter.name, "relay");
assert.equal(adapter.encodeThreadId({ chatId }), \`relay:\${chatId}\`);
assert.equal(RELAY_WEBHOOK_VERSION, "2026-08-30");
const empty = await adapter.postMessage(\`relay:\${chatId}\`, "");
assert.equal(empty.raw.noop, true);
assert.equal(resolverCalls, 0);
const sent = await adapter.postMessage(\`relay:\${chatId}\`, "installed");
assert.equal(sent.id, "22222222-2222-4222-8222-222222222222");
assert.equal(resolverCalls, 1);
console.log("installed runtime import ok");
`,
);
execFileSync("node", ["smoke.mjs"], {
  cwd: consumer,
  stdio: "inherit",
});

writeFileSync(
  resolve(consumer, "smoke.ts"),
  `
import type { Adapter } from "chat";
import {
  createRelayAdapter,
  type RelayAdapterOptions,
} from "@relaymessenger/chat-sdk-adapter";

const options: RelayAdapterOptions = {
  token: () => Promise.resolve("token"),
  webhookSecret: () => "whsec_dGVzdA==",
  idempotencyKeyResolver: ({ chatId }) => \`think-action:\${chatId}\`,
  typing: false,
};
const adapter: Adapter = createRelayAdapter(options);
void adapter;
`,
);
writeFileSync(
  resolve(consumer, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
      },
      include: ["smoke.ts"],
    },
    null,
    2,
  ),
);
execFileSync(
  resolve(consumer, "node_modules/.bin/tsc"),
  ["--project", "tsconfig.json"],
  { cwd: consumer, stdio: "inherit" },
);

const digest = createHash("sha512")
  .update(readFileSync(tarball))
  .digest("base64");
console.log(`installed type import ok`);
console.log(`tarball=${tarball}`);
console.log(`integrity=sha512-${digest}`);
console.log(`files=${contents.length}`);
