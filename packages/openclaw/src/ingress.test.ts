import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { createRelayIngressMonitor } from "./ingress.js";
import { openRelayStateStore } from "./state.js";

function relayEvent(id: string): RelayWebhookEvent {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "contact.added",
    event_id: id,
    created_at: "2026-09-01T00:00:00.000Z",
    trace_id: `trace-${id}`,
    agent_id: "00000000-0000-7000-8000-000000000001",
    data: {
      contact: {
        id: "00000000-0000-7000-8000-000000000002",
        handle: "alice",
        display_name: "Alice",
      },
      chat_id: "00000000-0000-7000-8000-000000000003",
    },
  };
}

describe("Relay durable ingress", () => {
  it("commits before receive resolves and suppresses replayed event_id work", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-ingress-"));
    try {
      const state = openRelayStateStore({
        stateDir,
        accountId: "default",
      });
      let durable = false;
      const queue = {
        ...state.ingressQueue,
        enqueue: async (...args: Parameters<typeof state.ingressQueue.enqueue>) => {
          const result = await state.ingressQueue.enqueue(...args);
          durable = true;
          return result;
        },
      };
      const dispatch = vi.fn(async (_event, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createRelayIngressMonitor({
        queue,
        dispatch,
        pollIntervalMs: 5,
      });
      monitor.start();

      await expect(monitor.receive(relayEvent("event-once"))).resolves.toEqual({
        kind: "durable",
      });
      expect(durable).toBe(true);
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledOnce();

      await expect(monitor.receive(relayEvent("event-once"))).resolves.toEqual({
        kind: "durable",
      });
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledOnce();
      await monitor.stop();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("durably accepts non-Message events without starting an agent turn twice", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-ingress-events-"));
    try {
      const state = openRelayStateStore({
        stateDir,
        accountId: "events",
      });
      const monitor = createRelayIngressMonitor({
        queue: state.ingressQueue,
        dispatch: async () => {},
        pollIntervalMs: 5,
      });
      monitor.start();
      await monitor.receive(relayEvent("contact-event"));
      await monitor.waitForIdle();
      await monitor.receive(relayEvent("contact-event"));
      await monitor.waitForIdle();
      expect(await state.ingressQueue.listPending({ limit: "all" })).toEqual([]);
      await monitor.stop();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
