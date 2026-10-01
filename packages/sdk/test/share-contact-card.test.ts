import { describe, expect, it } from "vitest";
import Relay, { RelayAPIError, type RequestOptions } from "../src/index.js";

function fixture(status = 204) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const relay = new Relay({ apiKey: "fixture-token", retryBaseDelayMs: 0, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return status === 204 ? new Response(null, { status }) : Response.json({ error: { code: 2001, message: "refused" } }, { status });
  } });
  return { calls, relay };
}

describe("share contact card", () => {
  it("sends a selected handle as JSON, escapes the chat ID, and passes request options", async () => {
    const { relay, calls } = fixture();
    expect(await relay.chats.shareContactCard("chat/id", { handle: "travel_bot" }, { headers: { "x-fixture": "share" } })).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.relayapp.im/v1/chats/chat%2Fid/share_contact_card");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ handle: "travel_bot" });
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-fixture")).toBe("share");
  });

  it("keeps omitted params bodyless, including the old request-options overload", async () => {
    const { relay, calls } = fixture();
    await relay.chats.shareContactCard("chat-id");
    await relay.chats.shareContactCard("chat-id", { headers: { "x-fixture": "legacy" }, maxRetries: 0 });
    await relay.chats.shareContactCard("chat-id", undefined, { headers: { "x-fixture": "third" } });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.body).toBeUndefined();
      expect(new Headers(call.init?.headers).has("content-type")).toBe(false);
    }
    expect(new Headers(calls[1]!.init?.headers).get("x-fixture")).toBe("legacy");
    expect(new Headers(calls[2]!.init?.headers).get("x-fixture")).toBe("third");
  });

  it("preserves getter-backed legacy request options", async () => {
    const { relay, calls } = fixture();
    const controller = new AbortController();
    class Options implements RequestOptions {
      get headers() { return { "x-fixture": "getter" }; }
      get signal() { return controller.signal; }
    }
    await relay.chats.shareContactCard("chat-id", new Options());
    expect(calls[0]!.init?.body).toBeUndefined();
    expect(new Headers(calls[0]!.init?.headers).get("x-fixture")).toBe("getter");
    controller.abort();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  it("keeps an empty options object bodyless", async () => {
    const { relay, calls } = fixture();
    await relay.chats.shareContactCard("chat-id", {});
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it("sends user_id as JSON to share a person's card, with an Idempotency-Key", async () => {
    const { relay, calls } = fixture();
    const user_id = "0199a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b";
    await relay.chats.shareContactCard("chat-id", { user_id }, { idempotencyKey: "person-1" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ user_id });
    expect(new Headers(calls[0]!.init?.headers).get("idempotency-key")).toBe("person-1");
  });

  it("refuses handle and user_id together without sending", async () => {
    const { relay, calls } = fixture();
    const both = { handle: "atlas", user_id: "0199a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b" };
    await expect(relay.chats.shareContactCard("chat-id", both)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("passes an empty handle to the server rather than sharing the caller's card", async () => {
    const { relay, calls } = fixture();
    await relay.chats.shareContactCard("chat-id", { handle: "" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ handle: "" });
  });

  it("sends idempotencyKey as the Idempotency-Key header in both call forms", async () => {
    const { relay, calls } = fixture();
    await relay.chats.shareContactCard("chat-id", { handle: "target_bot" }, { idempotencyKey: "share-1" });
    await relay.chats.shareContactCard("chat-id", { idempotencyKey: "own-1" });
    expect(calls.map((call) => new Headers(call.init?.headers).get("idempotency-key"))).toEqual(["share-1", "own-1"]);
    expect(calls[1]!.init?.body).toBeUndefined();
  });

  it.each([403, 404, 429, 503])("preserves HTTP %i without retrying a send", async (status) => {
    const { relay, calls } = fixture(status);
    const request = relay.chats.shareContactCard("chat-id", { handle: "target_bot" });
    await expect(request).rejects.toBeInstanceOf(RelayAPIError);
    await expect(request).rejects.toMatchObject({ status, code: 2001 });
    expect(calls).toHaveLength(1);
  });
});
