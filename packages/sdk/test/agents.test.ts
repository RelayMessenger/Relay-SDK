import { describe, expect, it, vi } from "vitest";
import Relay, { RelayAPIError, RELAY_V1_OPERATIONS } from "../src/index.js";

describe("existing agent lifecycle", () => {
  it("has no anonymous registration method or operation", () => {
    expect("createAgent" in Relay).toBe(false);
    expect(RELAY_V1_OPERATIONS.some(op => op.method === "POST" && op.path === "/v1/agents")).toBe(false);
    expect(() => new Relay({ apiKey: "" })).toThrow("required");
  });
  it("deletes encoded handle with bearer auth and no body", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const relay = new Relay({ apiKey: "existing-key", baseURL: "https://server.test", fetch });
    expect(await relay.agents.delete("a/b.dev")).toBeUndefined();
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/agents/a%2Fb.dev");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer existing-key");
  });
  it.each([200, 401, 403, 404, 409, 500])("does not confirm or retry delete status %s", async (status) => {
    const fetch = vi.fn(async () => Response.json({}, { status }));
    const relay = new Relay({ apiKey: "key", fetch });
    await expect(relay.agents.delete("a.dev", { maxRetries: 9 })).rejects.toBeInstanceOf(RelayAPIError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
