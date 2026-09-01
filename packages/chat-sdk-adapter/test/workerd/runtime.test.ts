import { env, exports } from "cloudflare:workers";
import type { Adapter, ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  createRelayAdapter,
  verifyWebhookSignature,
} from "../../src/index.js";
import {
  envelope,
  IDS,
  jsonResponse,
  signedRequest,
  WEBHOOK_SECRET,
} from "../helpers.js";

describe("workerd runtime", () => {
  it("loads the Worker harness", async () => {
    expect(env).toBeDefined();
    const response = await exports.default.fetch(
      "https://example.test/",
    );
    expect(await response.text()).toContain("workerd harness");
  });

  it("verifies Standard Webhooks using workerd Web Crypto", async () => {
    const request = await signedRequest(envelope());
    await expect(
      verifyWebhookSignature({
        headers: request.headers,
        payload: await request.text(),
        secret: WEBHOOK_SECRET,
      }),
    ).resolves.toBeUndefined();
  });

  it("uses workerd fetch-compatible resolver credentials", async () => {
    const token = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("workerd-token");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer workerd-token",
        );
        return jsonResponse(
          {
            chat_id: IDS.chat,
            message: {
              created_at: "2026-08-30T12:00:00.000Z",
              delivery_status: "sent",
              id: IDS.message,
              parts: [
                { reactions: null, type: "text", value: "hello" },
              ],
              sent_at: null,
            },
          },
          202,
        );
      },
    );
    const adapter = createRelayAdapter({
      fetch: fetchMock as typeof fetch,
      idempotencyKeyResolver: () => "workerd-send",
      token,
      typing: false,
    });
    const result = await adapter.postMessage(
      `relay:${IDS.chat}`,
      "hello",
    );
    expect(result.id).toBe(IDS.message);
    expect(token).toHaveBeenCalledOnce();
  });

  it("propagates inbound event idempotency through workerd async context", async () => {
    let key: string | null = null;
    const adapter = createRelayAdapter({
      fetch: (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        key = new Headers(init?.headers).get("idempotency-key");
        return jsonResponse(
          {
            chat_id: IDS.chat,
            message: {
              created_at: "2026-08-30T12:00:00.000Z",
              delivery_status: "sent",
              id: IDS.message,
              parts: [
                { reactions: null, type: "text", value: "reply" },
              ],
              sent_at: null,
            },
          },
          202,
        );
      }) as typeof fetch,
      token: "workerd-token",
      webhookSecret: WEBHOOK_SECRET,
    });
    await adapter.initialize({
      processMessage: async (
        inboundAdapter: Adapter,
        threadId: string,
      ) => {
        await inboundAdapter.postMessage(threadId, "reply");
      },
    } as unknown as ChatInstance);

    const response = await adapter.handleWebhook(
      await signedRequest(envelope()),
    );
    expect(response.status).toBe(200);
    expect(key).toBe(`relay-chat-sdk:${IDS.event}:0`);
  });
});
