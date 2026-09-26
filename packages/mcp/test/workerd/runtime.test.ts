import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Relay MCP on workerd", () => {
  it("boots the server and runs one TypeScript execute call end to end", async () => {
    const response = await exports.default.fetch("https://example.test/");
    expect(response.status).toBe(200);
    const outcome = await response.json() as {
      result: { isError?: boolean; structuredContent?: { result?: unknown } };
      requests: string[];
    };
    expect(outcome.result.isError).not.toBe(true);
    expect(outcome.result.structuredContent?.result).toBe("workerd");
    expect(outcome.requests).toEqual(["https://api.relay.test/v1/contact_card"]);
  });
});
