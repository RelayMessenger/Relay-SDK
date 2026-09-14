import { consoleFixture } from "../test/console-fixture.js";
import { birdFor, withBirdManifest } from "../test/bird-manifest.js";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createAgentWithPicture, forgetBirdManifests } from "./agent-create.js";
import { agentDependencies } from "./agents.js";
import { readConfig } from "./config.js";
import { inventedHandleAttempts } from "./console-auth.js";
import { protectWindowsPath } from "./runtime-connect/windows-acl.js";

// Handles are one flat namespace: once anyone has `my_agent`, every later
// create with nothing typed would collide. The Console answers a taken handle
// with 409 and its own code `handle_taken` (Relay-Console error-copy.ts).
const api = "https://api.staging.relayapp.im";
const taken = () => Response.json({ error: "That handle is taken. Choose another.", code: "handle_taken", details: { status: 409, code: "1005", docUrl: null } }, { status: 409 });

async function fixture(refusals: number, card = { handle: "", first_name: "My Agent", image_url: null }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relay-invented-handle-retry-")));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  const context = { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: api } };
  const console = consoleFixture(context, { handle: "unused", first_name: "My Agent", image_url: null });
  await console.login();
  const posted: string[] = [];
  const pictures: Array<{ handle: string | null; image_url: unknown }> = [];
  const fetch = withBirdManifest(console.wrap(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { handle: string };
    posted.push(body.handle);
    if (posted.length <= refusals) return taken();
    return Response.json({ agent: { handle: card.handle || body.handle, first_name: card.first_name, image_url: null }, secret: `rly_test_${posted.length}_0123456789`, share_url: "https://relayapp.im/x" }, { status: 201 });
  }), pictures);
  return { context, deps: agentDependencies(context, fetch), fetch, posted, pictures };
}

beforeEach(() => { forgetBirdManifests(); vi.spyOn(process.stderr, "write").mockImplementation(() => true); });

it("an invented handle taken twice is retried with a 4-letter, then a 6-letter suffix, and the bird follows the final handle", async () => {
  const { deps, fetch, posted, pictures } = await fixture(2);
  const created = await createAgentWithPicture({ apiURL: api }, deps, fetch);
  expect(posted).toHaveLength(3);
  expect(posted[0]).toBe("my_agent");
  expect(posted[1]).toMatch(/^my_agent_[a-z0-9]{4}$/u);
  expect(posted[2]).toMatch(/^my_agent_[a-z0-9]{6}$/u);
  expect(created.result.handle).toBe(posted[2]);
  expect(pictures).toEqual([{ handle: posted[2], image_url: birdFor(api, posted[2]!) }]);
});

it("gives up after the third refusal with the CLI's refusal message", async () => {
  const { deps, fetch, posted, pictures } = await fixture(3);
  await expect(createAgentWithPicture({ apiURL: api }, deps, fetch)).rejects.toThrow(/Relay refused to create this agent\. Relay said: error 409, code handle_taken\. That handle is taken\. Choose another\./u);
  expect(posted).toHaveLength(3);
  expect(pictures).toEqual([]);
});

it("a typed handle that is taken is never retried", async () => {
  const { deps, fetch, posted, pictures } = await fixture(1);
  await expect(createAgentWithPicture({ apiURL: api, handle: "ada" }, deps, fetch)).rejects.toThrow(/Relay refused to create this agent/u);
  expect(posted).toEqual(["ada"]);
  expect(pictures).toEqual([]);
});

it("a refusal that is not a taken handle is not retried, even for an invented handle", async () => {
  const { context, fetch: _unused, posted } = await fixture(0);
  const deps = agentDependencies(context, withBirdManifest(consoleFixture(context, { handle: "unused", first_name: "My Agent", image_url: null }).wrap(async (_url, init) => {
    posted.push((JSON.parse(String(init?.body)) as { handle: string }).handle);
    return Response.json({ error: "A handle is one word.", code: "1005", details: { status: 400, code: "1005" } }, { status: 400 });
  })));
  await expect(createAgentWithPicture({ apiURL: api }, deps)).rejects.toThrow(/Relay refused to create this agent/u);
  expect(posted).toEqual(["my_agent"]);
});

it("a second agent with the same returned handle still gets its own profile name", async () => {
  const { context, deps, fetch } = await fixture(0, { handle: "my_agent_ab12", first_name: "My Agent", image_url: null });
  const first = await createAgentWithPicture({ apiURL: api }, deps, fetch);
  const second = await createAgentWithPicture({ apiURL: api }, deps, fetch);
  expect(first.result.profile).toBe("my_agent_ab12");
  expect(second.result.profile).toBe("my_agent_ab12-2");
  const saved = await readConfig(context);
  expect(Object.keys(saved.profiles).sort()).toEqual(["default", "my_agent_ab12", "my_agent_ab12-2"]);
});

it("every attempt stays inside Relay's 32-character handle limit", () => {
  const attempts = inventedHandleAttempts("a".repeat(32));
  expect(attempts[0]).toHaveLength(32);
  expect(attempts[1]).toMatch(/^a{27}_[a-z0-9]{4}$/u);
  expect(attempts[2]).toMatch(/^a{25}_[a-z0-9]{6}$/u);
});
