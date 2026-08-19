import type { RenderedText } from "./format.js";
import type { RelayStyleRange } from "./types.js";

/** Relay caps one text part at 8 KB of UTF-8. */
export const MAX_TEXT_PART_BYTES = 8192;

/** Relay caps one message at 32 ordered parts. */
export const MAX_PARTS_PER_MESSAGE = 32;

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Largest UTF-16 index whose prefix still fits in `maxBytes` of UTF-8, always
 * landing on a code point boundary so a surrogate pair is never cut in half.
 */
function byteLimitIndex(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  for (const codePoint of text) {
    const size = encoder.encode(codePoint).length;
    if (bytes + size > maxBytes) return index;
    bytes += size;
    index += codePoint.length;
  }
  return text.length;
}

/**
 * Prefer a natural break inside the trailing quarter of the window: a blank
 * line, then a line break, then whitespace. A hard cut is the last resort, and
 * it still lands on a code point boundary.
 */
function breakIndex(text: string, limit: number): number {
  if (limit >= text.length) return text.length;
  const floor = Math.max(1, Math.floor(limit * 0.75));
  for (const separator of ["\n\n", "\n", " "]) {
    const found = text.lastIndexOf(separator, limit - separator.length);
    if (found >= floor) return found + separator.length;
  }
  return limit;
}

function sliceStyles(
  styles: RelayStyleRange[],
  start: number,
  end: number,
): RelayStyleRange[] {
  const out: RelayStyleRange[] = [];
  for (const run of styles) {
    const from = Math.max(run.start, start);
    const to = Math.min(run.start + run.length, end);
    if (to <= from) continue;
    out.push({ start: from - start, length: to - from, styles: run.styles });
  }
  return out;
}

/** How much whitespace sits at `from`, which a cut there consumes. */
function whitespaceRunLength(text: string, from: number): number {
  const run = /^\s+/.exec(text.slice(from));
  return run ? run[0].length : 0;
}

/**
 * Split rendered text into parts that each fit Relay's per-part ceiling.
 * Nothing is truncated: a long reply becomes more parts, and if it needs more
 * than one message the caller sends the overflow as follow-up messages.
 *
 * A cut consumes the whitespace run it lands on, and nothing else. Every part
 * draws as its own balloon on iOS
 * (`Relay-iOS/Relay/Views/Transcript/RelayCompositePartsModel.swift:6-7`), so a
 * part must not open with a blank line or close with a trailing space; the
 * whitespace at the seam is the only thing a split drops, and it is whitespace
 * between two balloons, which nobody can see.
 */
export function chunkRenderedText(
  rendered: RenderedText,
  maxBytes: number = MAX_TEXT_PART_BYTES,
): RenderedText[] {
  if (!rendered.text) return [];
  if (utf8Length(rendered.text) <= maxBytes) return [rendered];

  const chunks: RenderedText[] = [];
  let cursor = 0;
  while (cursor < rendered.text.length) {
    // A break separator shorter than the whitespace run it sits in leaves the
    // rest of that run at the cursor. Step over it, or the next part opens
    // with it: trimming only the tail cannot reach it.
    const lead = whitespaceRunLength(rendered.text, cursor);
    if (lead > 0) {
      cursor += lead;
      continue;
    }
    const remainder = rendered.text.slice(cursor);
    const limit = byteLimitIndex(remainder, maxBytes);
    // A single code point wider than the ceiling cannot happen (Relay's
    // ceiling is kilobytes), but a zero-length step would spin forever.
    const cut = limit <= 0 ? remainder.length : breakIndex(remainder, limit);
    const end = cursor + Math.max(1, cut);
    const text = rendered.text.slice(cursor, end);
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed) {
      chunks.push({
        text: trimmed,
        styles: sliceStyles(rendered.styles, cursor, cursor + trimmed.length),
      });
    }
    cursor = end;
  }
  return chunks;
}
