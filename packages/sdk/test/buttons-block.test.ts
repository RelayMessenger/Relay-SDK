import { describe, expect, it } from "vitest";
import { parseButtonsBlock, partsWithButtons, splitButtons } from "../src/buttons.js";

const block = (body: string) => "```buttons\n" + body + "\n```";

describe("splitButtons", () => {
  it("lifts a fenced buttons block out of the answer and keeps the words", () => {
    const answer = "Which time works?\n\n" + block('[{"label": "9am"}, {"label": "2pm"}]');
    expect(splitButtons(answer)).toEqual({
      text: "Which time works?",
      buttons: { type: "buttons", items: [{ label: "9am" }, { label: "2pm" }] },
    });
  });

  it("keeps text on both sides of the block and collapses the gap", () => {
    const answer = "Before\n" + block('[{"label": "A"}]') + "\nAfter";
    expect(splitButtons(answer).text).toBe("Before\n\nAfter");
  });

  it("returns a buttons-only message when the answer is only the block", () => {
    const split = splitButtons(block('[{"label": "Connect Google", "url": "https://accounts.example.test/o/oauth2"}]'));
    expect(split.text).toBe("");
    expect(split.buttons).toEqual({
      type: "buttons",
      items: [{ url: "https://accounts.example.test/o/oauth2", label: "Connect Google" }],
    });
    expect(partsWithButtons(split.text, split.buttons)).toEqual([split.buttons]);
  });

  it("accepts the wrapped part shape too, which is how one_time travels", () => {
    expect(splitButtons(block('{"type": "buttons", "items": [{"label": "Yes"}]}')).buttons)
      .toEqual({ type: "buttons", items: [{ label: "Yes" }] });
    expect(splitButtons(block('{"one_time": false, "items": [{"label": "Next"}]}')).buttons)
      .toEqual({ type: "buttons", items: [{ label: "Next" }], one_time: false });
    expect(parseButtonsBlock('{"one_time": "no", "items": [{"label": "Next"}]}')).toBe("one_time must be true or false");
  });

  it("lifts a block written with CRLF line endings", () => {
    const answer = "Pick\r\n```buttons\r\n[{\"label\": \"Yes\"}]\r\n```\r\nThanks";
    expect(splitButtons(answer)).toEqual({
      text: "Pick\n\nThanks",
      buttons: { type: "buttons", items: [{ label: "Yes" }] },
    });
  });

  it("leaves an answer without a block alone, whitespace included", () => {
    expect(splitButtons("  plain words  ")).toEqual({ text: "  plain words  " });
    expect(splitButtons("```json\n[1]\n```")).toEqual({ text: "```json\n[1]\n```" });
  });

  it("keeps a malformed block in the text and says why", () => {
    const cases: Array<[string, string]> = [
      ["[{label: Approve}]", "the buttons block is not valid JSON"],
      ['{"label": "Approve"}', "the buttons block must be a JSON array of items"],
      ["[]", "the buttons block has no items"],
      ['[{"label":"1"},{"label":"2"},{"label":"3"},{"label":"4"},{"label":"5"},{"label":"6"}]', "the buttons block has 6 items; the most is 5"],
      ['[{"url": "https://a.test"}]', "item 1 needs a label"],
      ['[{"label": "' + "x".repeat(81) + '"}]', "item 1 label is over 80 characters"],
      ['[{"label": "Open", "url": "ftp://a.test"}]', "item 1 url is not an http(s) URL"],
      ['[{"label": "A", "id": "a"}]', "item 1 has unknown field id"],
      ['["A"]', "item 1 is not an object"],
    ];
    for (const [body, error] of cases) {
      const answer = "Pick one\n" + block(body);
      expect(splitButtons(answer)).toEqual({ text: answer, error });
      expect(parseButtonsBlock(body)).toBe(error);
    }
  });

  it("builds the parts text first, then buttons, and caps the text", () => {
    const buttons = { type: "buttons" as const, items: [{ label: "A" }] };
    expect(partsWithButtons("hello world", buttons, 5)).toEqual([
      { type: "text", value: "hello" },
      buttons,
    ]);
    expect(partsWithButtons("hello", undefined)).toEqual([{ type: "text", value: "hello" }]);
  });
});
