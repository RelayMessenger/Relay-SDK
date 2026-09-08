import { describe, expect, it, vi } from "vitest";
import Relay, { RelayAPIError } from "../src/index.js";

const created = { agent: { handle: "brave_cangoo.dev", first_name: "Brave Canada Goose", last_name: null, image_url: "https://server.test/image.png", kind: "agent", is_active: true }, secret: "one-time-test-secret", share_url: "https://go.test/@brave_cangoo.dev" };

describe("agent lifecycle", () => {
  it("bootstraps without Authorization, with exact body and response", async () => {
    const fetch = vi.fn(async () => Response.json(created, { status: 201 }));
    expect(await Relay.createAgent({ token_name: "machine" }, { baseURL: "https://server.test/", fetch, headers: { authorization: "must-not-send", "x-request-id": "test" } })).toEqual(created);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://server.test/v1/agents");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"token_name":"machine"}');
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(new Headers(init.headers).get("x-request-id")).toBe("test");
  });
  it("defaults to a strict empty JSON object", async () => {
    const fetch = vi.fn(async () => Response.json(created, { status: 201 }));
    await Relay.createAgent(undefined, { fetch });
    expect((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body).toBe("{}");
  });
  it.each([429, 500, 503])("never retries bootstrap status %s", async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: "limited", code: 2008 } }, { status, headers: { "retry-after": "1" } }));
    await expect(Relay.createAgent({}, { fetch, maxRetries: 9 })).rejects.toMatchObject({ status, code: 2008, retryAfter: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry network uncertainty or invalid JSON", async () => {
    for (const failure of [async () => { throw new Error("disconnect"); }, async () => new Response("{", { status: 201 })]) {
      const fetch = vi.fn(failure);
      await expect(Relay.createAgent({}, { fetch, maxRetries: 9 })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("passes timeout/cancellation and leaves authenticated construction mandatory", async () => {
    expect(() => new Relay({ apiKey: "" })).toThrow("required");
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async (_url, init) => { init.signal.throwIfAborted(); return Response.json(created, { status: 201 }); });
    await expect(Relay.createAgent({}, { fetch, signal: controller.signal, timeout: 10 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
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

it("ignores an apiKey supplied by untyped bootstrap callers", async () => {
  let headers: Headers | undefined;
  await Relay.createAgent({}, {
    ...{ apiKey: "not-bootstrap-auth" },
    fetch: async (_url, init) => { headers = new Headers(init?.headers); return Response.json(created, { status: 201 }); },
  });
  expect(headers?.has("authorization")).toBe(false);
});

it("strips Authorization from a caller-supplied Headers instance", async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return Response.json(created, { status: 201 });
  });
  await Relay.createAgent({}, { headers: new Headers({ Authorization: "Bearer must-never-send" }), fetch });
  expect(fetch).toHaveBeenCalledOnce();
});

it("forwards optional identity fields and the existing rendered-image recipe pair unchanged", async () => {
  const body = { token_name: "Relay CLI", handle: "chosen_agent.dev", first_name: "Chosen Agent", image_url: "https://images.example.test/rendered.png", image_recipe: { recipe: { monogram: { initials: "CA" } }, background: { linearGradient: { colors: ["5B9BFA", "0B52C0"] as const } } } };
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("POST"); expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual(body);
    return Response.json(created, { status: 201 });
  });
  await Relay.createAgent(body, { fetch });
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not fall back to a random handle after a chosen-handle conflict", async () => {
  const fetch = vi.fn(async () => Response.json({ error: { message: "Handle is already in use.", code: 1005 } }, { status: 409 }));
  await expect(Relay.createAgent({ handle: "chosen_agent.dev" }, { fetch, maxRetries: 10 })).rejects.toMatchObject({ status: 409, code: 1005 });
  expect(fetch).toHaveBeenCalledOnce();
});
