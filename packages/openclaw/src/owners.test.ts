import { describe, expect, it, vi } from "vitest";
import { relaySenderPolicy, resolveRelayOwners } from "./owners.js";

const owner = "01a07f76-4e51-70e1-8b12-a269a5b1774b";

describe("whom the Relay channel answers", () => {
  it("answers the owners when allowFrom is unset", () => {
    expect(relaySenderPolicy({ allowFrom: [], owners: [owner] }))
      .toEqual({ dmPolicy: "allowlist", allowFrom: [owner] });
  });

  it("lets a configured allowFrom replace the owners", () => {
    expect(relaySenderPolicy({ allowFrom: ["friend-id"], owners: [owner] }))
      .toEqual({ dmPolicy: "allowlist", allowFrom: ["friend-id"] });
  });

  it("answers everyone only with OpenClaw's own spelling, allowFrom [\"*\"]", () => {
    expect(relaySenderPolicy({ allowFrom: ["*"], owners: [owner] }))
      .toEqual({ dmPolicy: "open", allowFrom: ["*"] });
  });

  it("answers no one when neither is known, never everyone", () => {
    expect(relaySenderPolicy({ allowFrom: [], owners: [] }))
      .toEqual({ dmPolicy: "allowlist", allowFrom: [] });
  });
});

describe("reading the owners from Relay", () => {
  it("reads owner_people Contact IDs from GET /v1/me with the Agent Token", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({
      id: "agent-id", handle: "agent", kind: "agent", display_name: "Agent", owner: null,
      owner_people: [{ id: owner, handle: "ada", display_name: "Ada" }, { handle: "no-id" }],
    }));
    await expect(resolveRelayOwners({ baseUrl: "https://api.staging.relayapp.im/", token: "rly_test", fetch }))
      .resolves.toEqual([owner]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.staging.relayapp.im/v1/me",
      expect.objectContaining({ headers: { Authorization: "Bearer rly_test" } }),
    );
  });

  it("fails the start instead of answering everyone when Relay cannot name the owner", async () => {
    const fetch = vi.fn(async () => Response.json({ error: {} }, { status: 503 }));
    await expect(resolveRelayOwners({ baseUrl: "https://api.relayapp.im", token: "rly_test", fetch }))
      .rejects.toThrow(/HTTP 503.*allowFrom/u);
  });
});
