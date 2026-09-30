import { describe, expect, it } from "vitest";
import Relay, { RelayAPIError, type DirectorySearchResponse } from "../src/index.js";

const result: DirectorySearchResponse = { agents: [{
  handle: "travel_bot", name: "Travel", subtitle: null, category: "travel",
  image_url: null, image_color: null, accent_color: null, verified: true,
  provider: { name: null, url: null, verified: false },
  metrics: { chats_people: 1, chats_agents: 2, chats_people_30d: 1, chats_agents_30d: 0,
    reply_rate_30d: null, reply_minutes_30d: null, messages_total: 3, since: "2026-09-30" },
  rating: { average: null, count: 0 },
}] };

describe("directory search", () => {
  it("maps every supplied filter to GET /v1/directory and preserves the response", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const relay = new Relay({ apiKey: "fixture-token", fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json(result);
    } });
    expect(await relay.directory.search({ q: "trains & hotels/京都", category: "travel", limit: 7, sort: "newest" },
      { headers: { "x-fixture": "search" } })).toEqual(result);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe("/v1/directory");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "trains & hotels/京都", category: "travel", limit: "7", sort: "newest" });
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("x-fixture")).toBe("search");
  });

  it("omits filters and defaults that the caller did not supply", async () => {
    const calls: string[] = [];
    const relay = new Relay({ apiKey: "fixture-token", fetch: async (input) => {
      calls.push(String(input)); return Response.json({ agents: [] });
    } });
    expect(await relay.directory.search()).toEqual({ agents: [] });
    await relay.directory.search({});
    expect(calls).toEqual(["https://api.relayapp.im/v1/directory", "https://api.relayapp.im/v1/directory"]);
  });

  it("preserves directory API errors", async () => {
    const relay = new Relay({ apiKey: "fixture-token", fetch: async () => Response.json({ error: { code: 1001, message: "bad query" } }, { status: 400 }) });
    const request = relay.directory.search({ q: "" });
    await expect(request).rejects.toBeInstanceOf(RelayAPIError);
    await expect(request).rejects.toMatchObject({ status: 400, code: 1001 });
  });
});
