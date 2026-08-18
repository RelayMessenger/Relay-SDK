/** In-memory event_id window for at-least-once delivery. */

export type EventDedupe = {
  has(eventId: string): boolean;
  /** Record only after the event was durably handled. */
  record(eventId: string): void;
};

export class MemoryDedupe implements EventDedupe {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("relay dedupe capacity must be a positive safe integer");
    }
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  record(eventId: string): void {
    if (!eventId) return;
    this.seen.add(eventId);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
