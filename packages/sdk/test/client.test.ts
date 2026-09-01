import { describe, expect, it } from "vitest";
import Relay, { RelayAPIError } from "../src/index.js";

describe("Relay transport", () => {
  it("retries retryable GET failures", async () => {
    let calls = 0;
    const client = new Relay({
      apiKey: "token",
      maxRetries: 2,
      retryBaseDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return calls < 3
          ? Response.json({ error: { message: "later" } }, { status: 503 })
          : Response.json({ chats: [], next_cursor: null });
      },
    });
    await client.chats.listChats();
    expect(calls).toBe(3);
  });

  it("retries message POST only when it has an idempotency key", async () => {
    let safeCalls = 0;
    const safe = new Relay({
      apiKey: "token",
      maxRetries: 1,
      retryBaseDelayMs: 0,
      fetch: async () => {
        safeCalls += 1;
        return safeCalls === 1
          ? Response.json({ error: { message: "later" } }, { status: 503 })
          : Response.json({});
      },
    });
    await safe.messages.create({
      to: ["bob"],
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "safe-key",
      },
    });
    expect(safeCalls).toBe(2);

    let unsafeCalls = 0;
    const unsafe = new Relay({
      apiKey: "token",
      maxRetries: 3,
      retryBaseDelayMs: 0,
      fetch: async () => {
        unsafeCalls += 1;
        return Response.json(
          { error: { message: "later" } },
          { status: 503 },
        );
      },
    });
    await expect(unsafe.messages.create({
      to: ["bob"],
      message: { parts: [{ type: "text", value: "hello" }] },
    })).rejects.toBeInstanceOf(RelayAPIError);
    expect(unsafeCalls).toBe(1);
  });

  it("exposes structured API errors", async () => {
    const client = new Relay({
      apiKey: "token",
      maxRetries: 0,
      fetch: async () => Response.json({
        error: {
          status: 409,
          code: 1005,
          message: "conflict",
          doc_url: "https://docs.relayapp.im/error",
        },
        trace_id: "trace-test",
      }, { status: 409 }),
    });
    const error = await client.chats.retrieve("chat").catch((value) => value);
    expect(error).toBeInstanceOf(RelayAPIError);
    expect(error).toMatchObject({
      status: 409,
      code: 1005,
      traceId: "trace-test",
      docURL: "https://docs.relayapp.im/error",
      retryable: false,
    });
  });

  it("uses RelayAPIError for paid-agent HTTP 402 responses", async () => {
    const client = new Relay({
      apiKey: "free-agent-token",
      maxRetries: 3,
      retryBaseDelayMs: 0,
      fetch: async () => Response.json({
        error: {
          status: 402,
          code: 2402,
          message: "A paid Handle is required to Add a user first.",
          doc_url: "https://docs.relayapp.im/errors/paid-handle-required",
        },
        trace_id: "trace-paid-handle-required",
      }, { status: 402 }),
    });

    const error = await client.contactRequests
      .create({ handle: "advait" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RelayAPIError);
    expect(error).toMatchObject({
      status: 402,
      code: 2402,
      traceId: "trace-paid-handle-required",
      docURL: "https://docs.relayapp.im/errors/paid-handle-required",
      retryable: false,
    });
  });

  it("does not retry Add requests", async () => {
    let calls = 0;
    const client = new Relay({
      apiKey: "paid-agent-token",
      maxRetries: 3,
      retryBaseDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return Response.json(
          { error: { message: "later" } },
          { status: 503 },
        );
      },
    });
    await expect(client.contactRequests.create({ handle: "advait" }))
      .rejects.toBeInstanceOf(RelayAPIError);
    expect(calls).toBe(1);
  });

  it("uploads raw bytes without Relay authorization", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    let captured: { input: string; init?: RequestInit } | undefined;
    const client = new Relay({
      apiKey: "must-not-leak",
      fetch: async (input, init) => {
        captured = { input: String(input), ...(init ? { init } : {}) };
        return new Response(null, { status: 204 });
      },
    });
    await client.attachments.upload({
      attachment_id: "attachment",
      upload_url: "https://upload.test/opaque",
      download_url: "https://download.test/opaque",
      http_method: "PUT",
      expires_at: "2026-08-28T00:00:00.000Z",
      required_headers: {
        "Content-Type": "application/zip",
        "Content-Length": "3",
      },
    }, bytes);
    expect(captured?.input).toBe("https://upload.test/opaque");
    expect(captured?.init?.method).toBe("PUT");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/zip");
    expect(headers.get("content-length")).toBe("3");
    expect(captured?.init?.body).toBe(bytes);
  });
});
