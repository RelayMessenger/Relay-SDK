import { RelayWebhookConfiguredError } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { assertRelayWebSocketAvailable } from "./gateway.js";

describe("Relay Webhook and WebSocket exclusivity", () => {
  it("allows WebSocket startup only with an empty Webhook subscription list", async () => {
    const list = vi.fn(async () => ({ subscriptions: [] }));
    await expect(
      assertRelayWebSocketAvailable({
        relay: {
          webhookSubscriptions: { list } as never,
        },
        accountId: "default",
      }),
    ).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
  });

  it("fails terminally when Relay Webhooks own event delivery", async () => {
    const list = vi.fn(async () => ({
      subscriptions: [
        {
          id: "00000000-0000-7000-8000-000000000001",
          target_url: "https://example.test/relay",
          subscribed_events: ["message.received" as const],
          is_active: true,
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    }));
    const error = await assertRelayWebSocketAvailable({
      relay: {
        webhookSubscriptions: { list } as never,
      },
      accountId: "default",
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RelayWebhookConfiguredError);
    expect(String(error)).toMatch(/delete them before using OpenClaw WebSocket/u);
  });
});
