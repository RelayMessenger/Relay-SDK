// Exercises the installed SDK and CLI program, never workspace imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [consumer, home] = process.argv.slice(2);
const require = createRequire(join(consumer, "package.json"));
const { default: Relay } = await import(pathToFileURL(require.resolve("@relaymessenger/sdk")));
assert.equal(typeof Relay.createAgent, "function");
assert.equal(typeof new Relay({ apiKey: "existing-test-key" }).agents.delete, "function");
const { runCLI } = await import(pathToFileURL(join(consumer, "node_modules/@relaymessenger/cli/dist/program.js")));
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
assert.equal(await runCLI(["agents", "create", "--json"], deps), 0);
let config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, token);
assert.equal(config.current_profile, "default");
assert.equal(await runCLI(["agents", "list", "--json"], deps), 0);
delete deps.configContext.env.RELAY_AGENT_TOKEN;
assert.equal(await runCLI(["--profile", card.handle, "agents", "delete", card.handle], deps), 1);
config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, token);
deleteStatus = 204;
assert.equal(await runCLI(["--profile", card.handle, "agents", "delete", card.handle], deps), 0);
config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.profiles[card.handle].agent_token, undefined);
assert.equal(calls.filter(({ init }) => init.method === "POST").length, 1);
assert.equal(output.concat(errors).join("").includes(token), false);
assert.equal(output.join("").includes('"secret"'), false);
console.log("Installed SDK/CLI agent lifecycle smoke passed");
