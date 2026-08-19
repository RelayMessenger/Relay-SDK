/**
 * Deterministic `Idempotency-Key` derivation for outbound sends, and the
 * `event_id` window that keeps at-least-once delivery from dispatching the
 * same inbound event twice.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return canonicalJson(withToJson.toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

async function digestHex(value: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, length);
}

/**
 * Key one outbound send against the inbound event that caused it: the event
 * id, the send's position in the turn, and a digest of the content.
 *
 * The content term is what makes a redelivery safe. Keyed on position alone, a
 * handler whose model wrote different words the second time would reuse the
 * first key with a different body, which Relay answers with 409
 * idempotency_conflict, so the event could never complete.
 *
 * Relay requires 8 to 255 characters, so the event id is bounded before the
 * digest is appended.
 */
export async function deriveIdempotencyKey(
  eventId: string,
  ordinal: number,
  content: unknown,
): Promise<string> {
  const hex = await digestHex(canonicalJson(content), 32);
  return `${eventId.slice(0, 180)}:${ordinal}:${hex}`;
}

/**
 * Key a send that no inbound event caused, such as a proactive session opened
 * against a stored thread. There is no event to key against and no way to tell
 * a deliberate repeat of the same words from a retry, so the key is unique per
 * call: it makes the request well formed without claiming a replay guarantee
 * the caller cannot have.
 */
export function unkeyedIdempotencyKey(conversationId: string): string {
  return `relay:${conversationId}:${crypto.randomUUID()}`;
}

/** Bounded insertion-ordered set of handled `event_id` values. */
export class DedupeWindow {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  record(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
