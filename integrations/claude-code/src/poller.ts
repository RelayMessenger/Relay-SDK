/**
 * Long-poll supervisor: repeatedly drains GET /v1/events, hands each event to
 * the callback in order, then advances the persisted cursor (ack-after-handoff,
 * Telegram getUpdates model). Errors back off exponentially with jitter.
 */

import type { RelayClient } from "./relayClient.ts";
import { RelayApiError } from "./relayClient.ts";
import type { RelayEvent } from "./types.ts";

export interface PollerOptions {
  client: RelayClient;
  getCursor: () => number;
  setCursor: (cursor: number) => void;
  onEvent: (event: RelayEvent) => Promise<void>;
  log: (message: string) => void;
  timeoutSeconds?: number;
  /** Test hook: sleep implementation. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const CONFLICT_BACKOFF_MS = 30_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function startPoller(options: PollerOptions): { stop: () => void; done: Promise<void> } {
  const controller = new AbortController();
  const sleep = options.sleep ?? defaultSleep;
  let backoffMs = BASE_BACKOFF_MS;

  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const batch = await options.client.pollEvents({
          cursor: options.getCursor(),
          timeoutSeconds: options.timeoutSeconds ?? 25,
          signal: controller.signal,
        });
        backoffMs = BASE_BACKOFF_MS;
        let batchFailed = false;
        for (const event of batch.events) {
          if (controller.signal.aborted) return;
          try {
            await options.onEvent(event);
          } catch (error) {
            // Do not ack past a failed handoff: keep the cursor, stop the
            // batch, and re-poll the same window after a backoff. Events that
            // already succeeded are skipped on replay by the caller's dedupe.
            options.log(
              `event ${event.event_id} handler failed: ${String(error)}; keeping cursor ${options.getCursor()} and retrying batch`,
            );
            batchFailed = true;
            break;
          }
        }
        if (batchFailed) {
          await sleep(BASE_BACKOFF_MS + Math.floor(Math.random() * 500), controller.signal);
          continue;
        }
        if (batch.next_cursor > options.getCursor()) {
          options.setCursor(batch.next_cursor);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        let waitMs = backoffMs;
        if (error instanceof RelayApiError) {
          if (error.status === 409) {
            // Webhook XOR or another long-poll consumer holds the stream.
            options.log(`long-poll conflict (${error.code}): ${error.message}; retrying in ${CONFLICT_BACKOFF_MS / 1000}s`);
            waitMs = CONFLICT_BACKOFF_MS;
          } else if (error.status === 401) {
            options.log("agent token rejected (401); check ~/.claude/channels/relay/.env, retrying in 60s");
            waitMs = MAX_BACKOFF_MS;
          } else {
            options.log(`long-poll failed (${error.status} ${error.code}); backing off ${Math.round(waitMs / 1000)}s`);
          }
        } else {
          options.log(`long-poll failed (${String(error)}); backing off ${Math.round(waitMs / 1000)}s`);
        }
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        await sleep(waitMs + Math.floor(Math.random() * 500), controller.signal);
      }
    }
  };

  const done = loop();
  return { stop: () => controller.abort(), done };
}
