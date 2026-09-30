import { describe, expect, it } from "vitest";
import { suggestionReply, type CarouselPart, type MessagePart, type MessagePartResponse, type RichCardPart } from "../src/index.js";

describe("rich cards", () => {
  it("types a card and a carousel an agent can send", () => {
    const card: RichCardPart = {
      type: "rich_card",
      media: { type: "image", url: "https://example.com/villa.jpg", height: "medium" },
      title: "Lagoon House, Railay",
      suggestions: [
        { type: "reply", label: "Book", id: "book_lagoon" },
        { type: "open_url", label: "Details", url: "https://example.com/lagoon", application: "webview" },
        { type: "create_calendar_event", label: "Save dates", start_time: "2026-11-14T14:00:00Z", end_time: "2026-11-16T11:00:00Z", title: "Krabi" },
      ],
    };
    const shelf: CarouselPart = { type: "carousel", card_width: "small", cards: [{ title: "A" }, { title: "B" }] };
    const parts: MessagePart[] = [{ type: "text", value: "This one fits." }, card, shelf];
    expect(parts.map((part) => part.type)).toEqual(["text", "rich_card", "carousel"]);
  });

  it("reads the reply's id and label beside the card part it answers", () => {
    const parts: MessagePartResponse[] = [
      { type: "text", value: "Book", reactions: null },
      { type: "suggestion_response", id: "book_lagoon", label: "Book" },
    ];
    expect(suggestionReply(parts, { message_id: "m1", part_index: 1 })).toEqual({
      id: "book_lagoon", label: "Book", reply_to: { message_id: "m1", part_index: 1 },
    });
    expect(suggestionReply(parts, { message_id: "m1" })).toBeUndefined();
    expect(suggestionReply([parts[0]!], { message_id: "m1", part_index: 1 })).toBeUndefined();
  });
});
