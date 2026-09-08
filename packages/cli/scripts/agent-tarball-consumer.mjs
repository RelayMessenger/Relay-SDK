// Exercises the installed SDK and CLI program, never workspace imports.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [consumer, home] = process.argv.slice(2);
const require = createRequire(join(consumer, "package.json"));
const { default: Relay } = await import(pathToFileURL(require.resolve("@relaymessenger/sdk")));
assert.equal(typeof Relay.createAgent, "function");
assert.equal(typeof new Relay({ apiKey: "existing-test-key" }).agents.delete, "function");
const { runCLI } = await import(pathToFileURL(join(consumer, "node_modules/relaymessenger/dist/program.js")));
const token = "tarball-one-time-agent-credential";
const configPath = join(home, "agent-config.json");
const card = { handle: "brave_cangoo.dev", first_name: "Brave Canada Goose", last_name: null, image_url: null, is_active: true, kind: "agent" };
const output = []; const errors = []; const calls = [];
let deleteStatus = 409;
const deps = {
  configContext: { env: { RELAY_CONFIG_PATH: configPath, RELAY_AGENT_TOKEN: "unrelated-env-token", RELAY_PROFILE: "default" } },
  stdout: (text) => output.push(text), stderr: (text) => errors.push(text),
  fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === "POST") {
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(init.body, "{}");
      return Response.json({ agent: card, secret: token, share_url: `https://go.test/@${card.handle}` }, { status: 201 });
    }
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
    if (init.method === "DELETE") return deleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ error: { message: "pending events" } }, { status: deleteStatus });
    return Response.json({ contact_cards: [card] });
  },
};
const nativeHome = join(home, "native Hermes profile");
await mkdir(nativeHome, { mode: 0o700 });
if (process.platform === "win32") {
  const { protectWindowsPath } = await import(pathToFileURL(join(consumer, "node_modules/relaymessenger/dist/runtime-connect/windows-acl.js")));
  await protectWindowsPath(nativeHome, true);
}
const nativeYaml = 'gateway:\n  platforms:\n    relayapp:\n      enabled: true\n      extra:\n        allowed_contacts: [alice]\n';
await writeFile(join(nativeHome, "config.yaml"), nativeYaml, { mode: 0o600 });
const handoffArgs = ["--connect", "hermes", "--runtime-home", nativeHome, "--runtime-state-dir", join(nativeHome, "relay"), "--confirm-configure", "--runtime-stopped"];
assert.equal(await runCLI(["agents", "create", "--json", ...handoffArgs], deps), 0);
assert.equal(JSON.parse(output[0]).handoff.status, "configured");
assert.equal(JSON.parse(output[0]).handoff.connected, false);
assert.ok((await readFile(join(nativeHome, ".env"), "utf8")).includes(token));
assert.equal((await readFile(join(nativeHome, ".env"), "utf8")).includes("unrelated-env-token"), false);
assert.equal(await readFile(join(nativeHome, "config.yaml"), "utf8"), nativeYaml);

let config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, token);
assert.equal(config.current_profile, "default");
assert.equal(await runCLI(["agents", "list", "--json"], deps), 0);
delete deps.configContext.env.RELAY_AGENT_TOKEN;
delete deps.configContext.env.RELAY_PROFILE;
assert.equal(await runCLI(["--profile", card.handle, "auth", "login", "--with-token", "--api-url", "https://api.staging.relayapp.im", ...handoffArgs], { ...deps, readStdin: async () => token }), 0);
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
console.log("Installed SDK/CLI agent lifecycle smoke passed");
