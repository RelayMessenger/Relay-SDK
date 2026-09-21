import { describe, expect, it } from "vitest";
import {
  answerMessages,
  indexedIdempotencyKey,
  splitLinks,
  standaloneLink,
} from "../src/index.js";

describe("standaloneLink", () => {
  it("reads a line that is nothing but one absolute URL", () => {
    expect(standaloneLink("https://example.com/listing/42")).toBe("https://example.com/listing/42");
    expect(standaloneLink("  http://example.com  ")).toBe("http://example.com");
  });

  it("leaves words, relative paths and other schemes alone", () => {
    for (const line of [
      "See https://example.com",
      "https://example.com and more",
      "example.com",
      "mailto:someone@example.com",
      "tel:+15555550100",
      "- https://example.com",
      "[docs](https://example.com)",
      "https://",
      "",
    ]) expect(standaloneLink(line), line).toBeUndefined();
  });

  it("refuses a URL past the server's limit", () => {
    expect(standaloneLink(`https://example.com/${"a".repeat(2_048)}`)).toBeUndefined();
  });
});

describe("splitLinks", () => {
  it("returns an answer with no link line untouched, whitespace included", () => {
    expect(splitLinks("  Two words, see https://example.com inline.  ")).toEqual([
      { type: "text", value: "  Two words, see https://example.com inline.  " },
    ]);
    expect(splitLinks("")).toEqual([]);
  });

  it("lifts a link on its own line and keeps the words around it, in order", () => {
    expect(splitLinks("Here is the place I found:\nhttps://example.com/listing/42\nWant me to book it?")).toEqual([
      { type: "text", value: "Here is the place I found:" },
      { type: "link", value: "https://example.com/listing/42" },
      { type: "text", value: "Want me to book it?" },
    ]);
  });

  it("keeps line breaks inside the words and trims only the edges", () => {
    expect(splitLinks("One\nTwo\n\nhttps://example.com\n\n")).toEqual([
      { type: "text", value: "One\nTwo" },
      { type: "link", value: "https://example.com" },
    ]);
  });

  it("gives each link its own segment, CRLF included", () => {
    expect(splitLinks("Two options:\r\nhttps://a.example\r\nhttps://b.example\r\n")).toEqual([
      { type: "text", value: "Two options:" },
      { type: "link", value: "https://a.example" },
      { type: "link", value: "https://b.example" },
    ]);
  });

  it("makes an answer that is only a URL one link segment", () => {
    expect(splitLinks("https://example.com")).toEqual([{ type: "link", value: "https://example.com" }]);
  });
});

describe("answerMessages", () => {
  const buttons = { type: "buttons" as const, items: [{ label: "Book it" }, { label: "Keep looking" }] };

  it("is one text Message for plain words", () => {
    expect(answerMessages("Just words")).toEqual({ messages: [[{ type: "text", value: "Just words" }]] });
  });

  it("puts the buttons under the words, as before, when there is no link", () => {
    expect(answerMessages("Coming?\n```buttons\n[{\"label\": \"Book it\"}, {\"label\": \"Keep looking\"}]\n```")).toEqual({
      messages: [[{ type: "text", value: "Coming?" }, buttons]],
    });
  });

  it("sends a link as its own Message and hangs the buttons under the last words", () => {
    const answer = "Found this:\nhttps://example.com/listing/42\nShall I book it?\n```buttons\n[{\"label\": \"Book it\"}, {\"label\": \"Keep looking\"}]\n```";
    expect(answerMessages(answer)).toEqual({
      messages: [
        [{ type: "text", value: "Found this:" }],
        [{ type: "link", value: "https://example.com/listing/42" }],
        [{ type: "text", value: "Shall I book it?" }, buttons],
      ],
    });
  });

  it("hangs the buttons under the words before a trailing link, never on the link", () => {
    const answer = "Shall I book it?\nhttps://example.com\n```buttons\n[{\"label\": \"Book it\"}]\n```";
    expect(answerMessages(answer).messages).toEqual([
      [{ type: "text", value: "Shall I book it?" }, { type: "buttons", items: [{ label: "Book it" }] }],
      [{ type: "link", value: "https://example.com" }],
    ]);
  });

  it("sends buttons alone after a link when there are no words", () => {
    expect(answerMessages("https://example.com\n```buttons\n[{\"label\": \"Open\"}]\n```").messages).toEqual([
      [{ type: "link", value: "https://example.com" }],
      [{ type: "buttons", items: [{ label: "Open" }] }],
    ]);
  });

  it("keeps a malformed buttons block in the words and says why", () => {
    const result = answerMessages("Pick\n```buttons\nnot json\n```");
    expect(result.error).toBe("the buttons block is not valid JSON");
    expect(result.messages).toEqual([[{ type: "text", value: "Pick\n```buttons\nnot json\n```" }]]);
  });
});

describe("indexedIdempotencyKey", () => {
  it("keeps the first Message on the answer's own key and indexes the rest", () => {
    expect(indexedIdempotencyKey("codex-bridge-abc", 0)).toBe("codex-bridge-abc");
    expect(indexedIdempotencyKey("codex-bridge-abc", 2)).toBe("codex-bridge-abc-2");
  });

  it("stays within 255 characters", () => {
    const key = indexedIdempotencyKey("k".repeat(255), 1);
    expect(key).toHaveLength(255);
    expect(key.endsWith("-1")).toBe(true);
  });
});

describe("a rejected selection block keeps link cards", () => {
  it("still sends each standalone link alone when the selection block is invalid", () => {
    const answer = 'Words\nhttps://example.com/x\n```selection\n[{"value":"a b","label":"A"}]\n```';
    const { messages, error } = answerMessages(answer);
    expect(error).toMatch(/option 1 needs an ASCII token value/u);
    expect(messages.map((parts) => parts.map((part) => part.type))).toEqual([["text"], ["link"], ["text"]]);
    expect(messages[1]).toEqual([{ type: "link", value: "https://example.com/x" }]);
    expect(messages[2]?.[0]).toMatchObject({ type: "text", value: expect.stringContaining("```selection") });
  });
});
