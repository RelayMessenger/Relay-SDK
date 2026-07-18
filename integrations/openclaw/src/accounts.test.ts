import { describe, expect, it } from "vitest";
import { resolveRelayAccount } from "./accounts.js";
import type { RelayCoreConfig } from "./types.js";

function cfg(baseUrl: string): RelayCoreConfig {
  return { channels: { relay: { token: "rly_test", baseUrl } } };
}

describe("Relay account origin normalization", () => {
  it("gives equivalent configured URLs one canonical consumer identity", () => {
    const plain = resolveRelayAccount({ cfg: cfg("https://api.relayapp.im") });
    const slashed = resolveRelayAccount({ cfg: cfg("HTTPS://API.RELAYAPP.IM:443/") });
    expect(plain.baseUrl).toBe("https://api.relayapp.im");
    expect(slashed.baseUrl).toBe(plain.baseUrl);
  });

  it("validates the environment-provided custom origin too", () => {
    expect(() =>
      resolveRelayAccount({
        cfg: { channels: { relay: { token: "rly_test" } } },
        env: { RELAY_BASE_URL: "http://relay.example.test" },
      }),
    ).toThrow(/must use HTTPS/);
  });
});
