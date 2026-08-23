import { describe, expect, it } from "vitest";
import { createRelayClient, normalizeRelayBaseUrl } from "./client.js";

describe("Relay API origin safety", () => {
  it("canonicalizes equivalent HTTPS origins", () => {
    expect(normalizeRelayBaseUrl(" HTTPS://API.RELAYAPP.IM:443/ ")).toBe(
      "https://api.relayapp.im",
    );
    expect(normalizeRelayBaseUrl("https://relay.example.test:8443")).toBe(
      "https://relay.example.test:8443",
    );
    expect(normalizeRelayBaseUrl("https://api.relayapp.im////")).toBe(
      "https://api.relayapp.im",
    );
  });

  it("allows explicit loopback HTTP for local harnesses", () => {
    expect(normalizeRelayBaseUrl("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790");
    expect(normalizeRelayBaseUrl("http://localhost:8790")).toBe("http://localhost:8790");
    expect(normalizeRelayBaseUrl("http://[::1]:8790")).toBe("http://[::1]:8790");
  });

  it("rejects token-bearing requests to insecure remote HTTP origins", () => {
    expect(() => normalizeRelayBaseUrl("http://api.relayapp.im")).toThrow(/must use HTTPS/);
    expect(() => normalizeRelayBaseUrl("http://192.168.1.5:8790")).toThrow(/must use HTTPS/);
    expect(() => normalizeRelayBaseUrl("http://127.example.test:8790")).toThrow(/must use HTTPS/);
  });

  it("rejects credentials, paths, queries, and fragments", () => {
    expect(() => normalizeRelayBaseUrl("https://user:secret@api.relayapp.im")).toThrow(
      /credentials/,
    );
    expect(() => normalizeRelayBaseUrl("https://api.relayapp.im/proxy")).toThrow(/without a path/);
    expect(() => normalizeRelayBaseUrl("https://api.relayapp.im?env=prod")).toThrow(/query/);
    expect(() => normalizeRelayBaseUrl("https://api.relayapp.im#token")).toThrow(/fragment/);
  });
});

describe("Relay API operation deadlines", () => {
  it("fails a hung endpoint with a retryable timeout", async () => {
    const fetchImpl = (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    const client = createRelayClient({
      baseUrl: "https://api.test",
      token: "tok",
      fetchImpl,
      requestTimeoutMs: 20,
    });
    await expect(client.getMe()).rejects.toMatchObject({
      kind: "retryable",
      message: expect.stringMatching(/timed out after 20ms/),
    });
  });

  it("reuses the caller's idempotency key after an ambiguous timeout", async () => {
    const keys: string[] = [];
    let attempt = 0;
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      attempt += 1;
      if (attempt === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      }
      return new Response(JSON.stringify({ message_id: "msg_1", message: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createRelayClient({
      baseUrl: "https://api.test",
      token: "tok",
      fetchImpl,
      requestTimeoutMs: 20,
    });
    const params = {
      conversationId: "cnv_1",
      parts: [{ type: "text" as const, text: "hello" }],
      idempotencyKey: "relay-send:stable:0",
    };
    await expect(client.sendMessage(params)).rejects.toThrow(/timed out/);
    await client.sendMessage(params);
    expect(keys).toEqual(["relay-send:stable:0", "relay-send:stable:0"]);
  });
});

describe("Relay responding", () => {
  it("posts the inbound watermark before a turn", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createRelayClient({
      baseUrl: "https://api.test",
      token: "tok",
      fetchImpl: async (input, init) => {
        requests.push({
          url: input,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(null, { status: 204 });
      },
    });

    await client.setResponding({
      conversationId: "cnv/a",
      messageId: "msg_2",
      label: "OpenClaw",
    });

    expect(requests).toEqual([
      {
        url: "https://api.test/v1/conversations/cnv%2Fa/responding",
        body: { message_id: "msg_2", label: "OpenClaw" },
      },
    ]);
  });
});

// The plugin used to run a second, hand-rolled client with no invocationId
// anywhere. An agent's first group mention therefore hit
// `403 group typing requires invocation_id` and wedged the whole event
// stream (REL-167). These pin that the adopted client puts the id on the wire
// for each of the three calls a group turn makes.
describe("group invocation on the wire", () => {
  function recordingClient(requests: Array<{ url: string; body: unknown }>) {
    return createRelayClient({
      baseUrl: "https://api.test",
      token: "tok",
      fetchImpl: async (input, init) => {
        requests.push({
          url: input,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ messages: [{ id: "msg_out" }] }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }

  it("sends invocation_id on the responding receipt", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    await recordingClient(requests).setResponding({
      conversationId: "cnv_g",
      messageId: "msg_2",
      label: "OpenClaw",
      invocationId: "inv_1",
    });
    expect(requests[0]?.body).toEqual({
      message_id: "msg_2",
      label: "OpenClaw",
      invocation_id: "inv_1",
    });
  });

  it("sends invocation_id on the typing indicator", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    await recordingClient(requests).setTyping({
      conversationId: "cnv_g",
      started: true,
      invocationId: "inv_1",
    });
    expect(requests[0]?.body).toEqual({ started: true, invocation_id: "inv_1" });
  });

  it("sends invocation_id on the reply itself", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    await recordingClient(requests).sendMessage({
      conversationId: "cnv_g",
      parts: [{ type: "text", text: "hi" }],
      invocationId: "inv_1",
      idempotencyKey: "relay-send:k:0",
    });
    expect(requests[0]?.body).toMatchObject({
      conversation_id: "cnv_g",
      invocation_id: "inv_1",
    });
  });

  it("omits invocation_id when there is none, so a DM body is unchanged", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    await recordingClient(requests).sendMessage({
      conversationId: "cnv_dm",
      parts: [{ type: "text", text: "hi" }],
      idempotencyKey: "relay-send:k:0",
    });
    expect(Object.keys(requests[0]?.body as Record<string, unknown>))
      .not.toContain("invocation_id");
  });
});
