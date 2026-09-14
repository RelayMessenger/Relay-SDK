import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Relay from "@relaymessenger/sdk";
import { birdImageUrl, createAgentWithPicture, forgetBirdManifests } from "./agent-create.js";
import type { AgentDependencies } from "./agents.js";
import { emptyConfig, type RelayConfig } from "./config.js";
import { birdFiles, withBirdManifest } from "../test/bird-manifest.js";

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
  const pictures: Array<{ handle: string | null; image_url: unknown }> = [];
  const manifestReads = { count: 0 };
  const served = withBirdManifest(async (input) => { throw new Error(`unexpected request ${input instanceof Request ? input.url : String(input)}`); }, pictures);
  // The manifest read is counted here, and turned into a failure when the case asks for one.
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/avatars/manifest.json") {
      expect(url.origin).toBe(api);
      manifestReads.count += 1;
      if (manifestStatus !== 200) return new Response("down", { status: manifestStatus });
    }
    return served(input, init);
  };
  return { deps, fetch, pictures, manifestReads };
}

describe("a CLI-invented agent gets a bird", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { forgetBirdManifests(); stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
  afterEach(() => { stderr.mockRestore(); });

  it("nothing supplied → the picture is the bird for the handle Relay returned, by sha256 first byte % 84", async () => {
    const { deps, fetch, pictures } = setup();
    const created = await createAgentWithPicture({ apiURL: api }, deps, fetch);
    // The create request itself carries no picture: Relay Console's create route takes none.
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "My Agent" });
    expect(pictures).toEqual([{ handle: inventedHandle, image_url: expectedBird }]);
    expect(created.result.image_url).toBe(expectedBird);
    expect(created.image).toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("the bird follows the handle Relay returned, not the one the CLI sent", async () => {
    const { deps, fetch, pictures } = setup();
    vi.mocked(deps.provision).mockResolvedValue({ agent: { ...card, handle: "my_agent_x1" }, token: secret });
    await createAgentWithPicture({ apiURL: api }, deps, fetch);
    const index = createHash("sha256").update("my_agent_x1", "utf8").digest()[0]! % 84;
    expect(pictures).toEqual([{ handle: "my_agent_x1", image_url: `${api}/avatars/${files[index]}` }]);
  });

  it("reads the manifest once per run", async () => {
    const { deps, fetch, manifestReads } = setup();
    await createAgentWithPicture({ apiURL: api }, deps, fetch);
    await createAgentWithPicture({ apiURL: api }, deps, fetch);
    expect(manifestReads.count).toBe(1);
  });

  it("name only → no picture from the CLI", async () => {
    const { deps, fetch, pictures, manifestReads } = setup();
    await createAgentWithPicture({ apiURL: api, firstName: "Ada" }, deps, fetch);
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "Ada" });
    expect(pictures).toEqual([]);
    expect(manifestReads.count).toBe(0);
  });

  it("handle only → no picture from the CLI", async () => {
    const { deps, fetch, pictures, manifestReads } = setup();
    await createAgentWithPicture({ apiURL: api, handle: "ada" }, deps, fetch);
    expect(vi.mocked(deps.provision).mock.calls[0]![0]).toEqual({ displayName: "My Agent", handle: "ada" });
    expect(pictures).toEqual([]);
    expect(manifestReads.count).toBe(0);
  });

  it("manifest 500 → no picture, the agent is still created, one stderr line", async () => {
    const { deps, fetch, pictures } = setup(500);
    const created = await createAgentWithPicture({ apiURL: api }, deps, fetch);
    expect(created.result.handle).toBe(inventedHandle);
    expect(created.image).toBeUndefined();
    expect(pictures).toEqual([]);
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
