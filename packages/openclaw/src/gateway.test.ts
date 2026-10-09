import { RelayAPIError, RelayWebhookConfiguredError } from "@relaymessenger/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRelayWebSocketAvailable, startRelayAccount } from "./gateway.js";
import { setRelayRuntime, type PluginRuntime } from "./runtime.js";
import type { ResolvedRelayAccount } from "./types.js";

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

describe("a refused Agent Token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // OpenClaw restarts a channel that exits with an error up to 10 times, 5 s to
  // 300 s apart, unless its status says terminalDisconnect (server-channels.ts).
  it("marks the account terminal so OpenClaw does not restart it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-openclaw-refused-"));
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      requests.push(String(input instanceof Request ? input.url : input));
      return Response.json({
        error: { status: 401, code: 2004, message: "Bearer authentication is required." },
        success: false,
        trace_id: "trace-refused",
      }, { status: 401 });
    });
    setRelayRuntime({
      state: {
        resolveStateDir: () => stateDir,
        openChannelIngressQueue: () => {
          throw new Error("only available for trusted plugins");
        },
      },
    } as unknown as PluginRuntime);
    const statuses: Array<Record<string, unknown>> = [];
    const account: ResolvedRelayAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      token: "rly_revoked",
      baseUrl: "https://relay.test",
      allowFrom: [],
      config: {} as ResolvedRelayAccount["config"],
    };
    try {
      const error = await startRelayAccount({
        account,
        accountId: "default",
        abortSignal: new AbortController().signal,
        cfg: {},
        setStatus: (status: Record<string, unknown>) => statuses.push(status),
        log: { warn: () => {}, error: () => {}, info: () => {} },
      } as never).catch((value: unknown) => value);

      expect(error).toBeInstanceOf(RelayAPIError);
      expect(error).toMatchObject({ status: 401, code: 2004 });
      expect(statuses).toContainEqual(expect.objectContaining({
        accountId: "default",
        running: false,
        terminalDisconnect: true,
      }));
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
