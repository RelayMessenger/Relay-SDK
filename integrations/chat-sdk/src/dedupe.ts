/**
 * The `event_id` window that keeps at-least-once delivery from dispatching the
 * same inbound event twice.
 */

/**
 * Bounded insertion-ordered set of handled `event_id` values.
 *
 * `claim` is the only way in, and it both tests and inserts with nothing
 * awaited in between, so two redeliveries of one event racing each other in
 * the same process cannot both win. The window lives in memory in one process:
 * a restart, or a second instance behind the same webhook URL, has no claim to
 * lose and will dispatch the event again. The `msg_` id the client mints per
 * logical send is what makes that second dispatch harmless — Relay replays the
 * id rather than committing it twice.
 */
export class DedupeWindow {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Take the event id. Answers false when it was already taken. */
  claim(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** Give the event id back, so a later delivery of it is dispatched. */
  release(id: string): void {
    this.seen.delete(id);
  }
}
