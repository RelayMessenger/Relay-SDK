import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Relay from "@relaymessenger/sdk";
import { birdImageUrl, createAgentWithPicture, forgetBirdManifests } from "./agent-create.js";
import type { AgentDependencies } from "./agents.js";
import { emptyConfig, type RelayConfig } from "./config.js";
import { birdFiles } from "../test/bird-manifest.js";

// The owner's picture tree (2026-09-14): nothing typed → a bird by the server's
// own rule; a name or a handle typed → no picture from the CLI, the server draws
// a monogram; a manifest that cannot be read → no picture and one stderr line.
const api = "https://api.staging.relayapp.im";
const files = birdFiles;
// sha256("my_agent") begins 0xe7 = 231; 231 % 84 = 63. Fixed here so the rule
// is asserted against a known digest, not re-derived by the code under test.
const inventedHandle = "my_agent";
expect(createHash("sha256").update(inventedHandle, "utf8").digest()[0]).toBe(231);
const expectedBird = `${api}/avatars/${files[63]}`;

const card = { handle: inventedHandle, first_name: "My Agent", last_name: null, image_url: null, is_active: true, kind: "agent" as const };
const secret = "one-time-secret-not-for-output";

function setup(manifestStatus = 200) {
  let config: RelayConfig = structuredClone(emptyConfig());
  const deps: AgentDependencies = {
    read: vi.fn(async () => structuredClone(config)),
    preflight: vi.fn(async () => undefined),
    update: vi.fn(async (change) => { const next = structuredClone(config); const result = change(next); config = next; return result; }),
    provision: vi.fn(async () => ({ agent: card, token: secret })),
    client: vi.fn(() => ({}) as unknown as Relay),
    auth: vi.fn(async () => { throw new Error("unused"); }),
    env: { RELAY_API_URL: api, RELAY_CONFIG_PATH: join(mkdtempSync(join(tmpdir(), "relay-bird-")), "config.json") },
  };
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.toString()).toBe(`${api}/avatars/manifest.json`);
    return manifestStatus === 200
      ? Response.json({ assets: files.map((file) => ({ file })), count: 84 })
      : new Response("down", { status: manifestStatus });
  }) as unknown as typeof globalThis.fetch;
  return { deps, fetch };
}

describe("a CLI-invented agent gets a bird", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { forgetBirdManifests(); stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
  afterEach(() => { stderr.mockRestore(); });

  it("nothing supplied → image_url is the bird for the invented handle, by sha256 first byte % 84", async () => {
    const { deps, fetch } = setup();
    await createAgentWithPicture({ apiURL: api }, deps, fetch);
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "My Agent", defaultImageURL: expectedBird });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reads the manifest once per run", async () => {
    const { deps, fetch } = setup();
    await createAgentWithPicture({ apiURL: api }, deps, fetch);
    await createAgentWithPicture({ apiURL: api }, deps, fetch);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("name only → no image_url", async () => {
    const { deps, fetch } = setup();
    await createAgentWithPicture({ apiURL: api, firstName: "Ada" }, deps, fetch);
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "Ada" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("handle only → no image_url", async () => {
    const { deps, fetch } = setup();
    await createAgentWithPicture({ apiURL: api, handle: "ada" }, deps, fetch);
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "My Agent", handle: "ada" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("manifest 500 → no image_url, the agent is still created, one stderr line", async () => {
    const { deps, fetch } = setup(500);
    const created = await createAgentWithPicture({ apiURL: api }, deps, fetch);
    expect(created.result.handle).toBe(inventedHandle);
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "My Agent" });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toMatch(/^Relay could not read the bird pictures \(HTTP 500\); the server will pick this agent's picture\.\n$/);
  });

  it("birdImageUrl follows the server's rule for any handle", async () => {
    const { fetch } = setup();
    const byte = createHash("sha256").update("assistant", "utf8").digest()[0]!;
    expect(byte).toBe(163);
    await expect(birdImageUrl(api, "assistant", fetch)).resolves.toBe(`${api}/avatars/${files[163 % 84]}`);
  });
});
