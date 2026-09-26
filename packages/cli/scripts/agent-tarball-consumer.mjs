import { installedConsoleFixture } from "../../../scripts/agent-cli-console-fixture.mjs";
// Exercises the installed SDK and CLI program, never workspace imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [consumer, home] = process.argv.slice(2);
const require = createRequire(join(consumer, "package.json"));
const { default: Relay } = await import(pathToFileURL(require.resolve("@relaymessenger/sdk")));
assert.equal("createAgent" in Relay, false);
assert.equal(typeof new Relay({ apiKey: "existing-test-key" }).agents.delete, "function");
const { runCLI } = await import(pathToFileURL(join(consumer, "node_modules/relaymessenger/dist/program.js")));
const token = "tarball-one-time-agent-credential";
const configPath = join(home, "agent-config.json");
const configModule = await import(pathToFileURL(join(consumer, "node_modules/relaymessenger/dist/config.js")));
const aclModule = process.platform === "win32" ? await import(pathToFileURL(join(consumer, "node_modules/relaymessenger/dist/runtime-connect/windows-acl.js"))) : undefined;
const originalParentACL = aclModule ? (await aclModule.inspectWindowsAcl(home)).sddl : undefined;
const card = { handle: "brave_cangoo", first_name: "Brave Canada Goose", last_name: null, image_url: null, is_active: true, kind: "agent" };
const output = []; const errors = []; const calls = [];
let deleteStatus = 409;
const deps = {
  configContext: { env: { RELAY_CONFIG_PATH: configPath, RELAY_AGENT_TOKEN: "unrelated-env-token", RELAY_PROFILE: "default" } },
  stdout: (text) => output.push(text), stderr: (text) => errors.push(text),
  fetch: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "POST") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer rel_org_installedFixtureOnly");
      assert.deepEqual(JSON.parse(init.body), { subtitle: "Helps with tasks" });
      return Response.json({ agent: card, secret: token, share_url: `https://go.test/@${card.handle}` }, { status: 201 });
    }
    assert.equal(new Headers(init.headers).get("authorization"), init.method === "DELETE" ? "Bearer rel_org_installedFixtureOnly" : `Bearer ${token}`);
    if (init.method === "DELETE") return deleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ error: { message: "pending events" } }, { status: deleteStatus });
    return Response.json({ contact_cards: [card] });
  },
};
const consoleAuth = await installedConsoleFixture(consumer, deps.configContext, card);
deps.consoleLogin = consoleAuth.login;
deps.fetch = consoleAuth.wrap(deps.fetch);
assert.equal(await runCLI(["agents", "create", "--subtitle", "Helps with tasks", "--json"], deps), 0);
assert.equal(JSON.parse(output[0]).handle, card.handle);
assert.equal(JSON.parse(output[0]).token, "stored");
assert.equal(JSON.parse(output[0]).image_url, card.image_url);
assert.equal(calls.some(({ init }) => init.method === "PATCH"), false);

// The front door ships in the tarball and can say what it would do without
// creating anything, running anything, or needing a terminal.
const plan = [];
assert.equal(await runCLI(["connect", "claude", "--subtitle", "Helps with tasks", "--dry-run"], {
  ...deps, isInteractive: false, stdout: (text) => plan.push(text), stderr: (text) => plan.push(text),
}), 0);
assert.match(plan.join(""), /keep running here, and answer your Relay messages with Claude Code from this folder; it runs no commands/);
assert.match(plan.join(""), /Relay's tools travel through the session; no mcp\.json is written/);
assert.doesNotMatch(plan.join(""), /\.env|marketplace/);
assert.match(plan.join(""), /Dry run: nothing was changed\./);
assert.equal(plan.join("").includes(token), false);

let config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, token);
const security = await configModule.inspectConfigPermissions(deps.configContext);
assert.equal(security.secure, true);
if (aclModule) {
  assert.equal(security.aclChecked, true);
  assert.equal(aclModule.privateWindowsAcl(await aclModule.inspectWindowsAcl(configPath)), true);
  assert.equal((await aclModule.inspectWindowsAcl(home)).sddl, originalParentACL);
}
assert.equal(config.current_profile, "default");
assert.equal(await runCLI(["agents", "list", "--json"], deps), 0);
delete deps.configContext.env.RELAY_AGENT_TOKEN;
delete deps.configContext.env.RELAY_PROFILE;
assert.equal(await runCLI(["--profile", card.handle, "auth", "login", "--with-token", "--api-url", configModule.defaultCreationApiURL()], { ...deps, readStdin: async () => token }), 0);
assert.equal((await configModule.inspectConfigPermissions(deps.configContext)).secure, true);
assert.equal(await runCLI(["--profile", card.handle, "doctor", "--offline"], deps), 0);
if (aclModule) assert.equal((await aclModule.inspectWindowsAcl(home)).sddl, originalParentACL);
assert.equal(await runCLI(["agents", "delete", card.handle], deps), 1);
config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, token);
deleteStatus = 204;
assert.equal(await runCLI(["agents", "delete", card.handle], deps), 0);
config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, undefined);
assert.equal(calls.filter(({ init }) => init.method === "POST").length, 1);
assert.equal(output.concat(errors).join("").includes(token), false);
assert.equal(output.join("").includes('"secret"'), false);

// Activity commands must work with the installed SDK, not only a mocked
// resource object from the source-tree tests.
const activityRequests = [];
const activityId = "01995bc0-0000-7000-8000-000000000003";
const activityClient = new Relay({
  apiKey: token,
  baseURL: "http://127.0.0.1:1",
  maxRetries: 0,
  fetch: async (url, init) => {
    activityRequests.push({ url: String(url), init });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({
      chat_id: "activity-smoke", agent_id: "agent", version: "9007199254740993",
      activity: { id: activityId, text: "Generating image", emoji: "🖼️",
        updated_at: "2026-09-20T12:00:00Z", expires_at: "2026-09-20T12:01:30Z" },
    });
  },
});
const activityOutput = [];
const activityDeps = {
  ...deps,
  stdout: (text) => activityOutput.push(text),
  stderr: (text) => activityOutput.push(text),
  resolveClient: async () => ({
    client: activityClient,
    auth: { profile: "default", apiURL: "http://127.0.0.1:1", token,
      tokenSource: "environment", configPath },
  }),
};
for (const args of [
  ["set", "activity-smoke", "--text", "Generating image", "--emoji", "🖼️"],
  ["set", "activity-smoke", "--text", "Generating image", "--activity-id", activityId, "--clear-emoji"],
  ["get", "activity-smoke"],
  ["clear", "activity-smoke", "--activity-id", activityId],
]) assert.equal(await runCLI(["chats", "activity", ...args], activityDeps), 0);
assert.deepEqual(activityRequests.map(({ init }) => init.method), ["PUT", "PUT", "GET", "DELETE"]);
assert.deepEqual(JSON.parse(activityRequests[1].init.body), {
  text: "Generating image", emoji: null, activity_id: activityId,
});
assert.equal(activityRequests[3].url,
  `http://127.0.0.1:1/v1/chats/activity-smoke/activity?activity_id=${activityId}`);
assert.equal(activityRequests[3].init.body, undefined);
assert.equal(activityOutput.join("").includes(token), false);
assert.match(activityOutput.join(""), /9007199254740993/);
console.log("Installed SDK/CLI agent lifecycle smoke passed");
