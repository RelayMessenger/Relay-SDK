function canonicalJson(value: unknown): string {
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

/**
 * Deterministic Idempotency-Key for one reply attempt.
 * Includes a content digest so a redelivery that produces different text does
 * not collide with a prior body under the same event id.
 */
export async function deriveIdempotencyKey(
  eventId: string,
  ordinal: number,
  content: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(content)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 32);
  return `${eventId.slice(0, 180)}:${ordinal}:${hex}`;
}

/** Simple key when the reply body is fixed for the event. */
export function replyIdempotencyKey(eventId: string, suffix = "0"): string {
  return `reply-${eventId}-${suffix}`;
}
