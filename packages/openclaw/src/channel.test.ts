import { afterEach, describe, expect, it, vi } from "vitest";
import {
  relayMessageAdapter,
} from "./channel.js";
import {
  RELAY_TEXT_CHUNK_LIMIT,
} from "./outbound.js";
import type { RelayCoreConfig } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenClaw Relay message adapter contract", () => {
  it("declares current durable text and unknown-send reconciliation surfaces", () => {
    expect(relayMessageAdapter.durableFinal).toMatchObject({
      automaticUnknownSendReconciliation: true,
      capabilities: {
        text: true,
        replyTo: true,
        messageSendingHooks: true,
        reconcileUnknownSend: true,
      },
      reconcileUnknownSendKinds: { text: true },
    });
    expect(relayMessageAdapter.send.text).toBeTypeOf("function");
    expect(relayMessageAdapter.receive).toEqual({
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    });
  });

  it("replays every chunk under the same per-part idempotency keys", async () => {
    const messagesByKey = new Map<string, string>();
    const requests: Array<{ key: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const key = headers.get("idempotency-key")!;
        const id =
          messagesByKey.get(key) ??
          `00000000-0000-7000-8000-${String(messagesByKey.size + 1).padStart(12, "0")}`;
        messagesByKey.set(key, id);
        requests.push({
          key,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          chat_id: "00000000-0000-7000-8000-000000000010",
          message: {
            id,
            parts: [{ type: "text", value: "chunk", reactions: null }],
            created_at: "2026-09-01T00:00:00.000Z",
            sent_at: "2026-09-01T00:00:00.000Z",
            delivery_status: "sent",
            is_system_message: false,
          },
        });
      },
    );

    const text = `${"a".repeat(RELAY_TEXT_CHUNK_LIMIT)}b`;
    const context = {
      cfg: {
        channels: {
          relay: {
            token: "rly_test",
            baseUrl: "https://relay.test",
          },
        },
      } as RelayCoreConfig,
      queueId: "queue-replay",
      channel: "relay",
      to: "00000000-0000-7000-8000-000000000010",
      enqueuedAt: 1,
      retryCount: 0,
      payloads: [{ text }],
    };
    const reconcile =
      relayMessageAdapter.durableFinal?.reconcileUnknownSend;
    expect(reconcile).toBeTypeOf("function");

    const first = await reconcile!(context);
    const second = await reconcile!(context);
    expect(first).toMatchObject({
      status: "sent",
      receipt: {
        platformMessageIds: [
          "00000000-0000-7000-8000-000000000001",
          "00000000-0000-7000-8000-000000000002",
        ],
      },
    });
    expect(second).toMatchObject({
      status: "sent",
      receipt: {
        platformMessageIds: [
          "00000000-0000-7000-8000-000000000001",
          "00000000-0000-7000-8000-000000000002",
        ],
      },
    });
    expect(requests.map((request) => request.key)).toEqual([
      "relay-openclaw:queue-replay:0",
      "relay-openclaw:queue-replay:1",
      "relay-openclaw:queue-replay:0",
      "relay-openclaw:queue-replay:1",
    ]);
    expect(messagesByKey).toHaveLength(2);
  });
});
