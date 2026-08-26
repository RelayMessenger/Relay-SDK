/**
 * Relay message ids, minted here.
 *
 * A Relay id is `<prefix>_<26-char lowercase Crockford ULID>`, and the `msg_`
 * one is the client's to mint. It is both the message's identity and the only
 * retry key a send has: repeating an id replays the committed message, and a
 * fresh id is a second message. So it is minted once per logical send and
 * persisted with that send, never re-drawn on retry.
 *
 * Relay rejects an uppercase id, and lowercasing a canonical ULID afterwards
 * is not the same thing as generating a lowercase one — `I` and `L` would
 * fold into characters this alphabet excludes. Hence the generator, rather
 * than a `.toLowerCase()` over some other library's output. This is a
 * condensed copy of `packages/sdk/src/ulid.ts`; the installed runtime is
 * standalone, so it cannot import it.
 */

import { randomBytes } from "node:crypto";

/** Crockford base32, lowercase, with i/l/o/u removed. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

export const RELAY_ID_PATTERN = /^[a-z]{2,4}_[0-9a-hjkmnp-tv-z]{26}$/;

function encodeTime(time: number): string {
  let remaining = time;
  let encoded = "";
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    const digit = remaining % ALPHABET.length;
    encoded = `${ALPHABET[digit]}${encoded}`;
    remaining = (remaining - digit) / ALPHABET.length;
  }
  return encoded;
}

/** A fresh `msg_` id. Mint one per logical send, then persist it. */
export function relayMessageId(now: number = Date.now()): string {
  // One byte per character reduced modulo the alphabet. The residual bias is
  // 8 values in 256 across 80 bits, far below anything a collision needs.
  const random = Array.from(randomBytes(RANDOM_LENGTH), (byte) => ALPHABET[byte % ALPHABET.length])
    .join("");
  return `msg_${encodeTime(now)}${random}`;
}
