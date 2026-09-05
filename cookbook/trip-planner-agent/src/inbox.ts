import { processAcceptedEvent, type ProcessorDependencies } from "./processor.js";
import type { TripStore } from "./store.js";

/**
 * Work happens here, outside the socket callback, so a slow model turn
 * never delays an acknowledgement. A failed turn is retried with backoff
 * from the same durable row.
 */
export class InboxProcessor {
  readonly #dependencies: ProcessorDependencies;
  readonly #store: TripStore;
  #running = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(store: TripStore, dependencies: ProcessorDependencies) {
    this.#store = store;
    this.#dependencies = dependencies;
  }

  start(): void {
    this.wake();
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    queueMicrotask(() => void this.#drain());
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      while (!this.#stopped) {
        const accepted = this.#store.claim();
        if (!accepted) break;
        try {
          await processAcceptedEvent(this.#dependencies, accepted.event);
          this.#store.complete(accepted.eventId);
        } catch (error) {
          const delayMs = Math.min(
            60_000,
            1_000 * 2 ** Math.min(accepted.attempts - 1, 6),
          );
          this.#store.retry(accepted.eventId, error, Date.now() + delayMs);
        }
      }
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  #scheduleNext(): void {
    if (this.#stopped) return;
    const next = this.#store.nextAvailableAt();
    if (next === null) return;
    const delay = Math.min(2_147_483_647, Math.max(0, next - Date.now()));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
  }
}
