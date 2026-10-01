import Relay from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { runCLI } from "./program.js";

interface Sent { method: string; path: string; query: Record<string, string>; headers: Headers; body: unknown }

async function run(args: string[], reply: (call: Sent) => Response = () => Response.json({ ok: "fixture" })) {
  const calls: Sent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = new Relay({ apiKey: "fixture-token", maxRetries: 0, fetch: async (input, init) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return reply(call);
  } });
  const code = await runCLI([...args, "--json"], {
    resolveClient: async () => ({ client, auth: { profile: "fixture", apiURL: client.baseURL,
      token: "fixture-token", tokenSource: "environment", configPath: "/unused" } }),
    stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
  });
  return { code, calls, stdout: stdout.join(""), stderr: stderr.join("") };
}

const one = async (args: string[], reply?: (call: Sent) => Response) => {
  const result = await run(args, reply);
  expect(result.code, result.stderr).toBe(0);
  expect(result.calls).toHaveLength(1);
  return { ...result.calls[0]!, stdout: result.stdout };
};

const PERSON = "0b4a6f3e-1c2d-4e5f-8a9b-7c6d5e4f3a2b";

describe("resource commands", () => {
  it("shares a person's card by user ID, and refuses a handle with it", async () => {
    const shared = await one(["contact-card", "share", "chat-1", "--user-id", PERSON], () => new Response(null, { status: 204 }));
    expect([shared.method, shared.path, shared.body]).toEqual(["POST", "/v1/chats/chat-1/share_contact_card", { user_id: PERSON }]);
    const both = await run(["contact-card", "share", "chat-1", "--user-id", PERSON, "--handle", "atlas"]);
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain("Choose --handle or --user-id, not both.");
    expect(both.calls).toHaveLength(0);
  });

  it("asks for and reads a chat's location", async () => {
    const asked = await one(["chats", "location", "request", "chat-1"]);
    expect([asked.method, asked.path]).toEqual(["POST", "/v1/chats/chat-1/location/request"]);
    const read = await one(["chats", "location", "get", "chat-1"]);
    expect([read.method, read.path]).toEqual(["GET", "/v1/chats/chat-1/location"]);
    expect(JSON.parse(read.stdout)).toEqual({ ok: "fixture" });
  });

  it("creates a payment request with every flag and an idempotency key", async () => {
    const created = await one(["payment-requests", "create", "--description", "House blend", "--category", "physical_goods",
      "--amount", "2400", "--currency", "usd", "--mode", "payment", "--image-url", "https://example.com/bag.png",
      "--coupon", "SPRING", "--discount-label", "Spring", "--metadata", "order=42", "--metadata", "note=a=b",
      "--idempotency-key", "pay-1"]);
    expect([created.method, created.path]).toEqual(["POST", "/v1/payment_requests"]);
    expect(created.headers.get("idempotency-key")).toBe("pay-1");
    expect(created.body).toEqual({
      description: "House blend", category: "physical_goods", amount: 2400, currency: "usd", mode: "payment",
      image_url: "https://example.com/bag.png", discount: { coupon: "SPRING", label: "Spring" },
      metadata: { order: "42", note: "a=b" },
    });
    const subscription = await one(["payment-requests", "create", "--description", "Club", "--category", "digital_goods",
      "--mode", "subscription", "--price-id", "price_1", "--quantity", "2", "--customer-id", "cus_1", "--promotion-code", "promo_1"]);
    expect(subscription.body).toEqual({ description: "Club", category: "digital_goods", mode: "subscription",
      price_id: "price_1", quantity: 2, customer_id: "cus_1", discount: { promotion_code: "promo_1" } });
    expect(subscription.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("lists, reads and cancels payment requests", async () => {
    const listed = await one(["payment-requests", "list", "--status", "requested", "--limit", "10", "--cursor", "c1"]);
    expect([listed.method, listed.path, listed.query]).toEqual(["GET", "/v1/payment_requests", { status: "requested", limit: "10", cursor: "c1" }]);
    expect((await one(["payment-requests", "get", "pr_1"])).path).toBe("/v1/payment_requests/pr_1");
    const canceled = await one(["payment-requests", "cancel", "pr_1"]);
    expect([canceled.method, canceled.path]).toEqual(["POST", "/v1/payment_requests/pr_1/cancel"]);
    const bad = await run(["payment-requests", "create", "--description", "x", "--category", "rent"]);
    expect(bad.code).not.toBe(0);
    expect(bad.calls).toHaveLength(0);
  });

  it("starts, lists, reads and ends calls", async () => {
    const started = await one(["calls", "create", "chat-1", "--to", "@ada", "--idempotency-key", "call-1"]);
    expect([started.method, started.path, started.body]).toEqual(["POST", "/v1/chats/chat-1/calls", { to: ["ada"] }]);
    expect(started.headers.get("idempotency-key")).toBe("call-1");
    const listed = await one(["calls", "list", "chat-1", "--limit", "5"]);
    expect([listed.method, listed.path, listed.query]).toEqual(["GET", "/v1/chats/chat-1/calls", { limit: "5" }]);
    expect((await one(["calls", "get", "call-9"])).path).toBe("/v1/calls/call-9");
    const ended = await one(["calls", "end", "call-9"]);
    expect([ended.method, ended.path]).toEqual(["POST", "/v1/calls/call-9/end"]);
  });

  it.each([
    [["--handle", "@Atlas"], { handle: "Atlas" }],
    [["--id", PERSON], { id: PERSON }],
    [["--task", "fix my bike"], { task: "fix my bike" }],
  ])("looks a contact up by %j", async (flags, body) => {
    const looked = await one(["contacts", "lookup", ...flags]);
    expect([looked.method, looked.path, looked.body]).toEqual(["POST", "/v1/contacts/lookup", body]);
  });

  it("refuses a lookup with none or two of handle, ID and task", async () => {
    for (const flags of [[], ["--handle", "a", "--task", "b"]]) {
      const result = await run(["contacts", "lookup", ...flags]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Choose exactly one of --handle, --id or --task.");
      expect(result.calls).toHaveLength(0);
    }
  });

  it("shows the agent this token signs in as, from GET /v1/me", async () => {
    const me = await one(["me"], () => Response.json({ handle: "echo", calls_enabled: true }));
    expect([me.method, me.path]).toEqual(["GET", "/v1/me"]);
    expect(JSON.parse(me.stdout)).toEqual({ handle: "echo", calls_enabled: true });
  });
});
