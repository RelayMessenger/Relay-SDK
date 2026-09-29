import { describe, expect, it, vi } from "vitest";
import Relay, { RelayAPIError } from "../src/index.js";

const card = (handle: string, kind: "user" | "agent" = "agent") => ({
  id: "01890000-0000-7000-8000-000000000001",
  handle,
  display_name: handle,
  kind,
  image_url: null,
  image_color: null,
  verified: false,
});

const call = (fetch: ReturnType<typeof vi.fn>, index = 0) => {
  const [url, init] = fetch.mock.calls[index] as unknown as [URL, RequestInit];
  return { url: new URL(url), init, headers: new Headers(init.headers) };
};

describe("client.access: Always Allow and Never Allow (GET/PUT/DELETE /v1/access)", () => {
  it("lists both lists with the agent's token", async () => {
    const fetch = vi.fn(async () => Response.json({ allow: [card("friend")], deny: [card("spam")] }));
    const relay = new Relay({ apiKey: "agent-token", baseURL: "https://server.test", fetch });
    const lists = await relay.access.list();
    expect(lists.allow.map((entry) => entry.handle)).toEqual(["friend"]);
    expect(lists.deny.map((entry) => entry.handle)).toEqual(["spam"]);
    const { url, init, headers } = call(fetch);
    expect([init.method, url.pathname]).toEqual(["GET", "/v1/access"]);
    expect(headers.get("authorization")).toBe("Bearer agent-token");
  });

  it("puts a handle on Always Allow with rule allow, and on Never Allow with rule deny", async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const { rule } = JSON.parse(String(init?.body)) as { rule: string };
      return Response.json({ rule, contact: card("other_agent") });
    });
    const relay = new Relay({ apiKey: "agent-token", baseURL: "https://server.test", fetch });
    expect((await relay.access.set("other_agent", { rule: "allow" })).rule).toBe("allow");
    expect((await relay.access.set("a/b", { rule: "deny" })).rule).toBe("deny");
    const first = call(fetch, 0);
    expect([first.init.method, first.url.pathname]).toEqual(["PUT", "/v1/access/other_agent"]);
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(first.init.body))).toEqual({ rule: "allow" });
    // A handle is one path segment, never a path.
    expect(call(fetch, 1).url.pathname).toBe("/v1/access/a%2Fb");
    expect(JSON.parse(String(call(fetch, 1).init.body))).toEqual({ rule: "deny" });
  });

  it("removes a handle from whichever list holds it and expects 204", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const relay = new Relay({ apiKey: "agent-token", baseURL: "https://server.test", fetch });
    expect(await relay.access.remove("other_agent")).toBeUndefined();
    const { url, init } = call(fetch);
    expect([init.method, url.pathname, init.body]).toEqual(["DELETE", "/v1/access/other_agent", undefined]);
  });

  it("surfaces Relay's refusals with their numeric codes", async () => {
    const fetch = vi.fn(async () => Response.json({
      error: { status: 404, code: 2001, message: "Contact was not found." },
      success: false,
    }, { status: 404 }));
    const relay = new Relay({ apiKey: "agent-token", baseURL: "https://server.test", fetch, maxRetries: 0 });
    const refusal = await relay.access.set("nobody_here", { rule: "allow" }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RelayAPIError);
    expect(refusal).toMatchObject({ status: 404, code: 2001 });
  });
});
