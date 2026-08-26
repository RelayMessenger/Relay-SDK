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

  // The message id is the whole idempotency mechanism now: a timeout leaves
  // the send's outcome unknown, and only replaying the same id can settle it
  // without risking a second visible message.
  it("reuses the caller's message id after an ambiguous timeout", async () => {
    const ids: unknown[] = [];
    let attempt = 0;
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      ids.push(JSON.parse(String(init?.body)).message_id);
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
      return new Response(JSON.stringify({ message: { id: "msg_stable" } }), {
        status: 201,
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
      messageId: "msg_stable",
      parts: [{ type: "text" as const, text: "hello" }],
    };
    await expect(client.sendMessage(params)).rejects.toThrow(/timed out/);
    await client.sendMessage(params);
    expect(ids).toEqual(["msg_stable", "msg_stable"]);
  });
});

describe("typing", () => {
  it("posts nothing but the flag", async () => {
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

    await client.setTyping({ conversationId: "cnv/a", started: true });

    expect(requests).toEqual([
      {
        url: "https://api.test/v1/conversations/cnv%2Fa/typing",
        body: { started: true },
      },
    ]);
  });
});
