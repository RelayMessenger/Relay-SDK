/**
 * Deterministic `Idempotency-Key` derivation for outbound sends, and the
 * `event_id` window that keeps at-least-once delivery from dispatching the
 * same inbound event twice.
 */

const KEY_PREFIX = "relay:";

/** Relay requires 8 to 255 characters on the `Idempotency-Key` header. */
const MAX_KEY_LENGTH = 255;

/**
 * Key one outbound send against the inbound event that caused it: the event id
 * and the send's position in the turn, and nothing else.
 *
 * The content is deliberately not in the key. Relay hashes the whole request
 * server side, stores that hash beside the key, replays the stored response
 * when a retry carries the same hash, and answers 409 `idempotency_conflict`
 * when it does not. Folding the content into the key would change the key
 * whenever the body changed, so the conflict could never fire and a handler
 * whose model wrote different words the second time would post a genuine
 * second message to the person. A key that names only the position is what
 * lets Relay replay a faithful retry and refuse a diverging one.
 *
 * The prefix keeps the key at or above the 8 character floor even for an empty
 * event id, and the event id is bounded so the whole key stays under 255.
 */
export function deriveIdempotencyKey(eventId: string, ordinal: number): string {
  const suffix = `:${ordinal}`;
  const room = MAX_KEY_LENGTH - KEY_PREFIX.length - suffix.length;
  return `${KEY_PREFIX}${eventId.slice(0, room)}${suffix}`;
}

/**
 * Key a send that no inbound event caused, such as a proactive session opened
 * against a stored thread. There is no event to key against and no way to tell
 * a deliberate repeat of the same words from a retry, so the key is unique per
 * call: it makes the request well formed without claiming a replay guarantee
 * the caller cannot have.
 */
export function unkeyedIdempotencyKey(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}:${crypto.randomUUID()}`;
}

/**
 * Bounded insertion-ordered set of handled `event_id` values.
 *
 * `claim` is the only way in, and it both tests and inserts with nothing
 * awaited in between, so two redeliveries of one event racing each other in
 * the same process cannot both win. The window lives in memory in one process:
 * a restart, or a second instance behind the same webhook URL, has no claim to
 * lose and will dispatch the event again. The `Idempotency-Key` on every send
 * is what makes that second dispatch harmless.
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
