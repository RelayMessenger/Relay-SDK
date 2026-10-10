import { describe, expect, it } from "vitest";
import { answerMessages, splitCardBlocks } from "../src/index.js";

const fence = (tag: string, body: unknown): string => `\`\`\`${tag}\n${JSON.stringify(body)}\n\`\`\``;

describe("card, carousel and place blocks", () => {
  it("sends a card with the words above it", () => {
    const card = { title: "Lagoon House", suggestions: [{ type: "reply", label: "Book", id: "book" }] };
    expect(answerMessages(`This one fits.\n\n${fence("rich_card", card)}`)).toEqual({
      messages: [[{ type: "text", value: "This one fits." }, { type: "rich_card", ...card }]],
    });
  });

  it("sends a carousel alone when there are no words", () => {
    const cards = [{ title: "A" }, { title: "B" }];
    expect(answerMessages(fence("carousel", { card_width: "small", cards }))).toEqual({
      messages: [[{ type: "carousel", card_width: "small", cards }]],
    });
  });

  it("keeps buttons under the card", () => {
    const answer = `Pick one.\n\n${fence("rich_card", { title: "A" })}\n\n${fence("buttons", [{ label: "Later" }])}`;
    expect(answerMessages(answer).messages).toEqual([[
      { type: "text", value: "Pick one." },
      { type: "rich_card", title: "A" },
      { type: "buttons", items: [{ label: "Later" }] },
    ]]);
  });

  it("sends a place as its own Message after the words and links", () => {
    const place = { latitude: 37.4422, longitude: -122.1615, name: "Philz Coffee" };
    expect(answerMessages(`Meet here.\nhttps://philz.example\n${fence("place", place)}`).messages).toEqual([
      [{ type: "text", value: "Meet here." }],
      [{ type: "link", value: "https://philz.example" }],
      [{ type: "place", ...place }],
    ]);
  });

  it("leaves a block that is not a card in the words, with the reason", () => {
    for (const [answer, error] of [
      [fence("carousel", { cards: [{ title: "A" }] }), "a carousel needs 2 to 10 cards"],
      [fence("rich_card", { suggestions: [] }), "a card needs media, a title or a description"],
      [fence("place", { latitude: 91, longitude: 0 }), "a place needs latitude (-90 to 90) and longitude (-180 to 180) as numbers"],
      ["```rich_card\nnot json\n```", "the rich_card block is not JSON"],
      [`${fence("rich_card", { title: "A" })}\n${fence("carousel", { cards: [{}, {}] })}`, "send at most one card or carousel and at most one place per answer"],
      [`${fence("rich_card", { title: "A" })}\n${fence("selection", { title: "T", options: [] })}`, "a card cannot be sent with a selection, form, payment or rating request"],
    ] as const) {
      expect(answerMessages(answer)).toEqual({ messages: [[{ type: "text", value: answer }]], error });
    }
  });

  it("leaves an answer with no such block untouched", () => {
    expect(splitCardBlocks("Just words.")).toEqual({ text: "Just words." });
  });
});
