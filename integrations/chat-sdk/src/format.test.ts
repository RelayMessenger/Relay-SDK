import { describe, expect, it } from "vitest";
import {
  normalizeStyles,
  prefixLines,
  renderAst,
  renderMarkdown,
  renderRawText,
} from "./format.js";
import { parseMarkdown } from "chat";

describe("renderMarkdown", () => {
  it("keeps the words and records emphasis as style ranges", () => {
    const rendered = renderMarkdown("hello **bold** and *soft*");
    expect(rendered.text).toBe("hello bold and soft");
    expect(rendered.styles).toEqual([
      { start: 6, length: 4, styles: ["bold"] },
      { start: 15, length: 4, styles: ["italic"] },
    ]);
  });

  it("flattens nested emphasis into one run carrying both styles", () => {
    const rendered = renderMarkdown("***both***");
    expect(rendered.text).toBe("both");
    expect(rendered.styles).toHaveLength(1);
    expect(rendered.styles[0]?.styles.slice().sort()).toEqual(["bold", "italic"]);
  });

  it("maps inline code and strikethrough onto Relay styles", () => {
    const rendered = renderMarkdown("run `npm ci` ~~later~~");
    expect(rendered.text).toBe("run npm ci later");
    expect(rendered.styles).toEqual([
      { start: 4, length: 6, styles: ["monospace"] },
      { start: 11, length: 5, styles: ["strikethrough"] },
    ]);
  });

  it("writes a link destination out rather than dropping it", () => {
    const rendered = renderMarkdown("see [the docs](https://docs.relayapp.im)");
    expect(rendered.text).toBe("see the docs (https://docs.relayapp.im)");
  });

  it("leaves a bare autolink as the url alone", () => {
    const rendered = renderMarkdown("<https://relayapp.im>");
    expect(rendered.text).toBe("https://relayapp.im");
  });

  it("keeps list markers and blockquote prefixes in the text", () => {
    const rendered = renderMarkdown("- one\n- two\n\n> quoted");
    expect(rendered.text).toBe("- one\n- two\n\n> quoted");
  });

  it("numbers an ordered list", () => {
    expect(renderMarkdown("1. one\n2. two").text).toBe("1. one\n2. two");
  });

  it("styles a heading bold instead of emitting hash marks", () => {
    const rendered = renderMarkdown("# Title\n\nbody");
    expect(rendered.text).toBe("Title\n\nbody");
    expect(rendered.styles).toEqual([{ start: 0, length: 5, styles: ["bold"] }]);
  });

  it("keeps a fenced code block verbatim and monospaced", () => {
    const rendered = renderMarkdown("```\nconst a = 1;\n```");
    expect(rendered.text).toBe("const a = 1;");
    expect(rendered.styles).toEqual([
      { start: 0, length: 12, styles: ["monospace"] },
    ]);
  });

  it("separates blocks with a blank line", () => {
    expect(renderMarkdown("one\n\ntwo").text).toBe("one\n\ntwo");
  });
});

describe("renderRawText", () => {
  it("marks verbatim text as structured plain text", () => {
    expect(renderRawText("**not markdown**")).toEqual({
      text: "**not markdown**",
      styles: [],
    });
  });
});

describe("renderAst", () => {
  it("renders the same tree renderMarkdown parses", () => {
    expect(renderAst(parseMarkdown("a **b**"))).toEqual(renderMarkdown("a **b**"));
  });
});

describe("normalizeStyles", () => {
  it("merges adjacent runs that carry the same styles", () => {
    expect(
      normalizeStyles([
        { start: 0, length: 3, styles: ["bold"] },
        { start: 3, length: 2, styles: ["bold"] },
      ]),
    ).toEqual([{ start: 0, length: 5, styles: ["bold"] }]);
  });

  it("caps the run count at Relay's ceiling", () => {
    const runs = Array.from({ length: 400 }, (_, index) => ({
      start: index * 2,
      length: 1,
      styles: ["bold" as const],
    }));
    expect(normalizeStyles(runs)).toHaveLength(200);
  });
});

describe("prefixLines", () => {
  it("shifts style offsets past the inserted prefixes", () => {
    const result = prefixLines(
      { text: "a\nb", styles: [{ start: 2, length: 1, styles: ["bold"] }] },
      "> ",
    );
    expect(result.text).toBe("> a\n> b");
    expect(result.styles).toEqual([{ start: 6, length: 1, styles: ["bold"] }]);
  });
});
