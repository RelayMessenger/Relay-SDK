// startAccount receive engine: abort-aware long poll over GET /v1/events with
// claim -> durable attempt commit -> dispatch per event and the cursor advanced
// only after the batch's commits. The supervisor owns restart/backoff: this loop settles
// (throws) on terminal auth failure and consumer conflicts, and only sleeps
// in-loop for transient errors.
import { RelayApiError, isAbortError } from "./client.js";
import type { RelayClient } from "./client.js";
import type { RelayCursorStore } from "./cursor-store.js";
import type { RelayInboundDeduper } from "./inbound-dedupe.js";
import type { RelayEvent } from "./types.js";

const TRANSIENT_BASE_DELAY_MS = 500;
const TRANSIENT_MAX_DELAY_MS = 30_000;

export type RelayPollLoopParams = {
  client: RelayClient;
  cursorStore: RelayCursorStore;
  deduper: RelayInboundDeduper;
  abortSignal: AbortSignal;
  /**
   * Handle one event after its attempt marker is durable. Throwing is logged
   * and acknowledged, not replayed, because the agent may already have run
   * non-idempotent tools.
   */
  handleEvent: (event: RelayEvent) => Promise<void>;
  /**
   * Cheap pre-dedupe classification: events returning false (receipts,
   * reactions, echoes) are acked by the batch cursor without burning a
   * dedupe claim/commit or a dispatch.
   */
  shouldProcess?: (event: RelayEvent) => boolean;
  timeoutSeconds?: number;
  limit?: number;
  onBatch?: (events: readonly RelayEvent[]) => void;
  log?: (line: string) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runRelayPollLoop(params: RelayPollLoopParams): Promise<void> {
  const sleep = params.sleep ?? defaultSleep;
  const random = params.random ?? Math.random;
  const log = params.log ?? (() => {});
  let transientAttempts = 0;

  const transientDelayMs = () => {
    const backoff = Math.min(
      TRANSIENT_MAX_DELAY_MS,
      TRANSIENT_BASE_DELAY_MS * 2 ** Math.min(transientAttempts, 6),
    );
    return backoff + Math.floor(random() * 250);
  };

  while (!params.abortSignal.aborted) {
    let page;
    try {
      page = await params.client.pollEvents({
        cursor: params.cursorStore.current(),
        timeoutSeconds: params.timeoutSeconds ?? 30,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        signal: params.abortSignal,
      });
    } catch (error) {
      if (params.abortSignal.aborted || isAbortError(error)) {
        return;
      }
      if (error instanceof RelayApiError && error.kind === "auth") {
        // Token revoked: settle so the supervisor applies terminalDisconnect
        // (server-channels.ts:718) — an operator has to fix the token.
        throw error;
      }
      if (error instanceof RelayApiError && error.kind === "conflict") {
        // Another consumer took the long poll. Settle and let the
        // supervisor's backoff arbitrate.
        log(`[relay] long poll terminated by another consumer: ${error.message}`);
        throw error;
      }
      transientAttempts += 1;
      log(`[relay] transient poll error (attempt ${transientAttempts}): ${String(error)}`);
      await sleep(transientDelayMs(), params.abortSignal);
      continue;
    }
    transientAttempts = 0;

    if (page.events.length > 0) {
      params.onBatch?.(page.events);
    }

    let batchFailed = false;
    for (const event of page.events) {
      if (params.abortSignal.aborted) {
        batchFailed = true;
        break;
      }
      if (params.shouldProcess && !params.shouldProcess(event)) {
        // Bookkeeping events (receipts, reactions, echoes) never dispatch, so
        // they are acked by the batch cursor without a dedupe row.
        continue;
      }
      const claimed = await params.deduper.claimEvent(event.event_id);
      if (claimed) {
        try {
          // This is the side-effect boundary. A crash or thrown dispatch after
          // this write must suppress replay, because a deploy/delete/send may
          // already have happened even when no final reply was delivered.
          await params.deduper.commitEvent(event.event_id);
        } catch (error) {
          // Nothing has been dispatched yet, so a failed attempt-marker write
          // is safe to release and retry.
          params.deduper.releaseEvent(event.event_id);
          log(`[relay] event ${event.event_id} attempt commit failed, will replay: ${String(error)}`);
          batchFailed = true;
          break;
        }
        if (params.abortSignal.aborted) {
          // This event's attempt is durable, but the unvisited tail is not.
          // Never acknowledge the page-level cursor past that tail.
          batchFailed = true;
          break;
        }
        try {
          await params.handleEvent(event);
        } catch (error) {
          log(
            `[relay] event ${event.event_id} dispatch failed after its attempt was committed; ` +
              `will not replay possible tool side effects: ${String(error)}`,
          );
        }
      }
    }

    // The server's next_cursor covers the whole page (cursor N acks <= N), so
    // only a batch with durable attempt markers may ack it. A marker-write
    // failure acks nothing and committed predecessors absorb the replay.
    if (!batchFailed) {
      await params.cursorStore.advance(page.nextCursor);
    } else {
      await sleep(transientDelayMs(), params.abortSignal);
    }
  }
}
