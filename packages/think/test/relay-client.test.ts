import { describe, expect, it } from "vitest";

import { createRelayClient } from "../src/typing";

describe("createRelayClient", () => {
  it("refuses a missing or blank agent token", () => {
    expect(() => createRelayClient({})).toThrow("RELAY_AGENT_TOKEN is not configured");
    expect(() => createRelayClient({ RELAY_AGENT_TOKEN: "  " })).toThrow(
      "RELAY_AGENT_TOKEN is not configured",
    );
  });

  it("talks to the configured Relay API origin", () => {
    const relay = createRelayClient({
      RELAY_AGENT_TOKEN: "relay-test-token",
      RELAY_API_ORIGIN: "https://api.example.test",
    });
    expect(relay.baseURL).toBe("https://api.example.test");
  });
});
