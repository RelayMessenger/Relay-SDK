import { describe, expect, it } from "vitest";

import { plainChatText } from "../src/plain-text";

describe("plainChatText", () => {
  it("drops heading marks and keeps the words", () => {
    expect(plainChatText("### The verdict\nIt holds.")).toBe("The verdict\nIt holds.");
    expect(plainChatText("# Title #\n\nBody")).toBe("Title\n\nBody");
  });

  it("puts each bullet item on its own line without its mark", () => {
    expect(plainChatText("Bring:\n- a jacket\n* snacks\n+ water")).toBe("Bring:\na jacket\nsnacks\nwater");
  });

  it("puts each numbered item on its own line without its number", () => {
    expect(plainChatText("Steps:\n1. Preheat\n2) Bake")).toBe("Steps:\nPreheat\nBake");
  });

  it("drops task-list boxes", () => {
    expect(plainChatText("- [ ] book flight\n- [x] pack")).toBe("book flight\npack");
  });

  it("drops a horizontal rule", () => {
    expect(plainChatText("First part.\n\n---\n\nSecond part.")).toBe("First part.\n\nSecond part.");
  });

  it("drops blockquote marks, keeping paragraph breaks", () => {
    expect(plainChatText("> said once\n> and again\n>\n> then this")).toBe("said once\nand again\n\nthen this");
  });

  it("drops code fences and keeps the code", () => {
    expect(plainChatText("Run:\n\n```sh\nnpm test\n```")).toBe("Run:\n\nnpm test");
  });

  it("turns a table into one line per row", () => {
    expect(plainChatText("| Day | Plan |\n|---|---|\n| Mon | Hike |\n| Tue | Rest |"))
      .toBe("Day, Plan\nMon, Hike\nTue, Rest");
  });

  it("keeps inline bold, italic, strikethrough, code and links as written", () => {
    const inline = "**bold** __strong__ *it* _it_ ~~old~~ `x_y` [site](https://example.com) a_b_c 2 * 3";
    expect(plainChatText(`## Note\n${inline}`)).toBe(`Note\n${inline}`);
    expect(plainChatText(`- ${inline}`)).toBe(inline);
  });

  it("passes plain text through byte for byte", () => {
    for (const text of [
      "on my way",
      "  spaced  out \n\n\nthree breaks, trailing space ",
      "escaped \\* star, &amp; entity, a_b, line  \nbreak",
      "**bold** and _it_ only",
      "",
    ]) expect(plainChatText(text)).toBe(text);
  });

  // A real clone reply from a group chat, shortened and reworded.
  it("turns a clone reply into plain chat text", () => {
    const reply = [
      "Here is the core of their thesis:",
      "",
      "1. Compute is power.",
      "2. Owning the box means **owning** your mind.",
      "",
      "### 1. They mix up compute and control.",
      "Control today lives in:",
      "- your keys",
      "- your memory",
      "",
      "---",
      "",
      "### The verdict:",
      "Their box stays home. _You_ do not.",
    ].join("\n");
    expect(plainChatText(reply)).toBe([
      "Here is the core of their thesis:",
      "",
      "Compute is power.",
      "Owning the box means **owning** your mind.",
      "",
      "1. They mix up compute and control.",
      "Control today lives in:",
      "your keys",
      "your memory",
      "",
      "The verdict:",
      "Their box stays home. _You_ do not.",
    ].join("\n"));
  });
});
