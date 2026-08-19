import { describe, expect, it } from "vitest";
import { MAX_TEXT_PART_BYTES, chunkRenderedText, utf8Length } from "./chunk.js";
import { renderRawText } from "./format.js";

describe("chunkRenderedText", () => {
  it("leaves a message that fits as one chunk", () => {
    const rendered = renderRawText("short");
    expect(chunkRenderedText(rendered)).toEqual([rendered]);
  });

  it("returns nothing for empty text", () => {
    expect(chunkRenderedText(renderRawText(""))).toEqual([]);
  });

  it("chunks an over-long message instead of truncating it", () => {
    const paragraphs = Array.from(
      { length: 400 },
      (_, index) => `paragraph number ${index} with enough words to matter`,
    ).join("\n\n");
    const chunks = chunkRenderedText(renderRawText(paragraphs));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8Length(chunk.text)).toBeLessThanOrEqual(MAX_TEXT_PART_BYTES);
    }
    // Nothing is dropped: every word survives into some chunk.
    const rejoined = chunks.map((chunk) => chunk.text).join("\n\n");
    expect(rejoined).toBe(paragraphs);
  });

  it("breaks at a boundary rather than mid-word", () => {
    const text = Array.from({ length: 60 }, () => "alpha bravo charlie").join(" ");
    const chunks = chunkRenderedText(renderRawText(text), 64);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith(" ")).toBe(false);
      expect(chunk.text.endsWith(" ")).toBe(false);
    }
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(text);
  });

  it("opens no chunk with the whitespace left over from the cut", () => {
    // The break separator is one space, but the run is twenty, so the cut
    // lands inside it and the rest of the run sits at the next cursor. Trimming
    // only the tail cannot reach it, and each chunk is its own balloon.
    const text = `${"a".repeat(50)}${" ".repeat(20)}${"b".repeat(50)}`;
    const chunks = chunkRenderedText(renderRawText(text), 56);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(chunk.text.trim());
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(
      `${"a".repeat(50)}${"b".repeat(50)}`,
    );
  });

  it("drops whitespace at a cut and nothing else", () => {
    const text = Array.from(
      { length: 200 },
      (_, index) => `paragraph ${index}   with\ttabs and    runs of spaces`,
    ).join("\n \n\n");
    const chunks = chunkRenderedText(renderRawText(text), 128);
    expect(chunks.length).toBeGreaterThan(1);
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(chunks.map((chunk) => chunk.text).join(""))).toBe(strip(text));
    for (const chunk of chunks) {
      expect(chunk.text).toBe(chunk.text.trim());
    }
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(200);
    const chunks = chunkRenderedText(renderRawText(text), 64);
    for (const chunk of chunks) {
      expect(chunk.text).toBe([...chunk.text].join(""));
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(utf8Length(chunk.text)).toBeLessThanOrEqual(64);
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  });

  it("rebases style ranges onto each chunk", () => {
    const text = `${"a".repeat(40)} ${"b".repeat(40)}`;
    const chunks = chunkRenderedText(
      { text, styles: [{ start: 41, length: 40, styles: ["bold"] }] },
      48,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.styles).toEqual([]);
    expect(chunks[1]?.styles).toEqual([
      { start: 0, length: 40, styles: ["bold"] },
    ]);
  });
});
