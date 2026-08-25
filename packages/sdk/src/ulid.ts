/**
 * Relay ids, minted client-side.
 *
 * Every prefixed Relay id is `<prefix>_<26-char lowercase Crockford ULID>`.
 * The client mints the ones it owns before it queues the request: a `msg_` id
 * for a send and a `mut_` id for an edit, unsend or reaction change. That is
 * what makes a retry after a lost response unambiguous, so the generator has
 * to be correct rather than convenient.
 *
 * Two properties matter and are tested:
 *
 *  - **Grammar.** Crockford base32 with `i`, `l`, `o` and `u` removed, always
 *    lowercase. Relay rejects an uppercase id, so emitting the canonical
 *    uppercase ULID and lowercasing it afterwards is not the same thing as
 *    generating a lowercase one: `I` and `L` would lowercase into characters
 *    the alphabet excludes.
 *  - **Monotonicity within a process.** Two ids minted in the same
 *    millisecond still sort in the order they were created, because the
 *    random component is incremented rather than redrawn. Relay orders by id
 *    where timestamps tie, so a batch minted in one tick must not shuffle.
 *
 * No dependencies: the whole thing is 16 bytes of `crypto.getRandomValues`
 * and a base32 encoder.
 */

/** Crockford base32, lowercase, with i/l/o/u removed. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const ENCODING_LENGTH = ALPHABET.length;
/** 48 bits of milliseconds, which runs out in the year 10889. */
const MAX_TIME = 281_474_976_710_655;

export const RELAY_ID_PATTERN = /^[a-z]{2,4}_[0-9a-hjkmnp-tv-z]{26}$/;

function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new Error(`relay: cannot encode ${time} as a ULID timestamp`);
  }
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
  // One byte per character, reduced modulo the alphabet. The residual bias is
  // 8 values out of 256 across 80 bits of randomness, which is far below what
  // any collision here would need.
  return Array.from(bytes, (byte) => byte % ENCODING_LENGTH);
}

/**
 * Increment the random component by one, right to left. Returns false when
 * every digit is already at its maximum, which needs 2^80 ids inside one
 * millisecond and therefore never happens.
 */
function increment(digits: number[]): boolean {
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = digits[index] ?? 0;
    if (digit < ENCODING_LENGTH - 1) {
      digits[index] = digit + 1;
      return true;
    }
    digits[index] = 0;
  }
  return false;
}

export type UlidFactory = (seedTime?: number) => string;

/**
 * A monotonic ULID generator with its own state.
 *
 * Prefer the shared `ulid` below; take a private factory when a test needs a
 * deterministic clock, or when two independent streams must not share a
 * counter.
 */
export function createUlidFactory(now: () => number = Date.now): UlidFactory {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return (seedTime?: number): string => {
    const time = seedTime ?? now();
    if (time <= lastTime) {
      // Same millisecond, or a clock that went backwards. Both are handled the
      // same way: keep the earlier timestamp and advance the random component,
      // so ids stay strictly increasing whatever the clock does.
      if (!increment(lastRandom)) {
        throw new Error("relay: ULID random component overflowed within one millisecond");
      }
    } else {
      lastTime = time;
      lastRandom = randomDigits();
    }
    let random = "";
    for (const digit of lastRandom) random += ALPHABET[digit];
    return `${encodeTime(lastTime)}${random}`;
  };
}

const sharedUlid = createUlidFactory();

/** A bare 26-character lowercase Crockford ULID, monotonic in this process. */
export function ulid(): string {
  return sharedUlid();
}

/**
 * A prefixed Relay id, for the ids a client owns.
 *
 * ```ts
 * relayId("msg"); // msg_01k1m9x2ph4vb7k0d3wzr8ftqe
 * ```
 */
export function relayId(prefix: string): string {
  if (!/^[a-z]{2,4}$/.test(prefix)) {
    throw new Error(`relay: ${JSON.stringify(prefix)} is not a Relay id prefix`);
  }
  return `${prefix}_${ulid()}`;
}

/** True when `value` is a well-formed id with this prefix. */
export function isRelayId(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && RELAY_ID_PATTERN.test(value)
    && value.startsWith(`${prefix}_`);
}
