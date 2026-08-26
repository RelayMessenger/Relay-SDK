/**
 * The `msg_` id this adapter mints for every send.
 *
 * Relay has no `Idempotency-Key` header any more: the client-minted message id
 * IS the idempotency mechanism. The same id sent twice is a replay, and the
 * same id from another sender is a 409. So the generator has to be correct
 * rather than convenient, and two properties matter:
 *
 *  - **Grammar.** Crockford base32 with `i`, `l`, `o` and `u` removed, always
 *    lowercase. Relay rejects an uppercase id, and lowercasing a canonical
 *    uppercase ULID is not the same thing as generating a lowercase one: `I`
 *    and `L` would fold into characters the alphabet excludes.
 *  - **Monotonicity within a process.** Two ids minted in the same millisecond
 *    still sort in the order they were created, because the random component
 *    is incremented rather than redrawn. Relay orders by id where timestamps
 *    tie, so a reply chunked into several messages must not shuffle.
 *
 * Kept byte-compatible with `@relaymessenger/sdk`'s `ulid.ts`, which is the
 * reference implementation; this package is dependency-free by design.
 */

/** Crockford base32, lowercase, with i/l/o/u removed. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const ENCODING_LENGTH = ALPHABET.length;

function encodeTime(time: number): string {
  let remaining = time;
  let encoded = "";
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    const digit = remaining % ENCODING_LENGTH;
    encoded = `${ALPHABET[digit]}${encoded}`;
    remaining = (remaining - digit) / ENCODING_LENGTH;
  }
  return encoded;
}

/** Random component as alphabet indices, so it can be incremented in place. */
function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte % ENCODING_LENGTH);
}

/** Advance the random component by one, right to left. */
function increment(digits: number[]): void {
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = digits[index] ?? 0;
    if (digit < ENCODING_LENGTH - 1) {
      digits[index] = digit + 1;
      return;
    }
    digits[index] = 0;
  }
  throw new Error("relay: ULID random component overflowed within one millisecond");
}

let lastTime = -1;
let lastRandom: number[] = [];

/** A bare 26-character lowercase Crockford ULID, monotonic in this process. */
export function ulid(): string {
  const time = Date.now();
  if (time <= lastTime) {
    // Same millisecond, or a clock that went backwards. Both are handled the
    // same way: keep the earlier timestamp and advance the random component,
    // so ids stay strictly increasing whatever the clock does.
    increment(lastRandom);
  } else {
    lastTime = time;
    lastRandom = randomDigits();
  }
  let random = "";
  for (const digit of lastRandom) random += ALPHABET[digit];
  return `${encodeTime(lastTime)}${random}`;
}

/**
 * A prefixed Relay id, for the ids this client owns.
 *
 * ```ts
 * relayId("msg"); // msg_01k1m9x2ph4vb7k0d3wzr8ftqe
 * ```
 */
export function relayId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
