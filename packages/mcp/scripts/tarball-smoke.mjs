import { candidateTarball, candidateConsumerManifest, assertInstalledCandidate } from "../../sdk/scripts/candidate-tarball.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const release = resolve(root, ".release-tmp", "mcp-pack-smoke");
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n`
      + `${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

run("npm", [
  "pack",
  "--ignore-scripts",
  "--pack-destination",
  release,
]);
const tarballs = (await readdir(release)).filter((name) => name.endsWith(".tgz"));
assert.equal(tarballs.length, 1);
const tarball = resolve(release, tarballs[0]);
const listing = run("tar", ["-tzf", tarball]).stdout.trim().split("\n").sort();
for (const required of [
  "package/LICENSE",
  "package/README.md",
  "package/dist/auth.js",
  "package/dist/cli.js",
  "package/dist/server.js",
  "package/package.json",
]) {
  assert.ok(listing.includes(required), `tarball is missing ${required}`);
}
for (const path of listing) {
  assert.doesNotMatch(path, /(?:^|\/)(?:\.env|\.npmrc|src|test|contracts)(?:\/|$)/);
}

const candidate = candidateTarball({
  name: "@relaymessenger/sdk", version: sourceManifest.dependencies["@relaymessenger/sdk"],
  variable: "RELAY_SDK_CANDIDATE_TARBALL",
});
const consumer = await mkdtemp(join(tmpdir(), "relay-mcp-consumer-"));
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify(candidate ? candidateConsumerManifest({ private: true, type: "module" }, [candidate]) : { private: true, type: "module" }),
);
const sdkRelease = join(release, "sdk");
await mkdir(sdkRelease);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", sdkRelease], {
  cwd: resolve(root, "../sdk"),
});
const sdkTarballs = (await readdir(sdkRelease)).filter((name) => name.endsWith(".tgz"));
assert.equal(sdkTarballs.length, 1);
run("npm", ["install", "--ignore-scripts", join(sdkRelease, sdkTarballs[0]), tarball], { cwd: consumer });
const bin = join(
  consumer,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "relay-mcp.cmd" : "relay-mcp",
);
if (process.platform !== "win32") await chmod(bin, 0o755);
assert.equal(
  run(bin, ["--version"], { cwd: consumer }).stdout.trim(),
  sourceManifest.version,
);
for (const relativePath of ["README.md", "dist/generated-docs.js", "dist/search-docs.js"]) {
  const text = await readFile(join(consumer, "node_modules", "@relaymessenger", "mcp", relativePath), "utf8");
  assert.doesNotMatch(text, /Relay\.createAgent/u, `removed signup docs in packed ${relativePath}`);
}

const home = await mkdtemp(join(tmpdir(), "relay-mcp-installed-home-"));
const activityId = "01995bc0-0000-7000-8000-000000000003";
const activityRequests = [];
const fixtureServer = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  activityRequests.push({ method: request.method, url: request.url, body });
  if (request.method === "DELETE") {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    chat_id: "activity-smoke", agent_id: "agent", version: "9007199254740993",
    activity: { id: activityId, text: "Generating image", emoji: "🖼️",
      updated_at: "2026-09-20T12:00:00Z", expires_at: "2026-09-20T12:01:30Z" },
  }));
});
await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(0, "127.0.0.1", resolve);
});
const fixtureAddress = fixtureServer.address();
assert.ok(fixtureAddress && typeof fixtureAddress === "object");
const transport = new StdioClientTransport({
  command: bin,
  env: {
    HOME: home,
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: join(home, ".config"),
    RELAY_API_URL: `http://127.0.0.1:${fixtureAddress.port}`,
    RELAY_AGENT_TOKEN: "mcp-pack-fixture-not-a-real-token",
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "installed-relay-mcp-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
);
try {
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getProtocolEra(), "modern");
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["execute", "search_docs"]);
  const docs = await client.callTool({ name: "search_docs", arguments: { query: "contact card", language: "typescript" } });
  assert.notEqual(docs.isError, true);
  assert.match(JSON.stringify(docs), /client\.contactCard\.retrieve/);
  const signup = await client.callTool({ name: "search_docs", arguments: { query: "anonymous agent signup", language: "typescript", detail: "verbose" } });
  assert.notEqual(signup.isError, true);
  assert.doesNotMatch(JSON.stringify(signup.structuredContent), /Relay\.createAgent|POST\s+\/v1\/agents(?:["\s]|$)/u);
  const executed = await client.callTool({ name: "execute", arguments: { code: "async function run(client) { return 6 * 7; }" } });
  assert.notEqual(executed.isError, true);
  assert.equal(executed.structuredContent.result, 42);
  const activityDocs = await client.callTool({ name: "search_docs", arguments: { query: "activity" } });
  assert.notEqual(activityDocs.isError, true);
  assert.match(JSON.stringify(activityDocs), /client\.chats\.setActivity/);
  const activity = await client.callTool({ name: "execute", arguments: { code: `async function run(client) {
    const state = await client.chats.setActivity("activity-smoke", {text:"Generating image",emoji:"🖼️"});
    const current = await client.chats.getActivity("activity-smoke");
    await client.chats.clearActivity("activity-smoke", {activity_id:state.activity.id});
    return current.version;
  }` } });
  assert.notEqual(activity.isError, true);
  assert.equal(activity.structuredContent.result, "9007199254740993");
  assert.deepEqual(activityRequests, [
    { method: "PUT", url: "/v1/chats/activity-smoke/activity", body: '{"text":"Generating image","emoji":"🖼️"}' },
    { method: "GET", url: "/v1/chats/activity-smoke/activity", body: "" },
    { method: "DELETE", url: `/v1/chats/activity-smoke/activity?activity_id=${activityId}`, body: "" },
  ]);
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
}

const installedManifest = JSON.parse(
  await readFile(
    join(consumer, "node_modules", "@relaymessenger", "mcp", "package.json"),
  ),
);
assert.equal(installedManifest.dependencies["@modelcontextprotocol/server"], "2.0.0");
assert.equal(
  installedManifest.dependencies["@relaymessenger/sdk"],
  sourceManifest.dependencies["@relaymessenger/sdk"],
);
assert.equal(installedManifest.dependencies["@modelcontextprotocol/client"], undefined);
console.log(`MCP tarball install/protocol smoke OK (${candidate ? "local candidate; NOT registry/release validation" : "registry dependencies"}): ${tarball}`);
