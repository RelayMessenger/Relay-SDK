import { describe, expect, it } from "vitest";

import { authorName, isAddressedToAgent, messageText } from "../src/processor.js";
import { AGENT_HANDLE, ALICE, inboundMessage } from "./fixtures.js";

let counter = 0;
const id = (): string =>
  `01993d50-ef7b-7b37-886b-23fd80c7e${(counter += 1).toString().padStart(3, "0")}`;

describe("who the agent answers", () => {
  it("answers every message in a direct Chat", () => {
    expect(isAddressedToAgent(inboundMessage({
      eventId: id(),
      isGroup: false,
      messageId: id(),
      text: "plan me a weekend in Lisbon",
    }))).toBe(true);
  });

  it("stays silent in a group until it is mentioned", () => {
    expect(isAddressedToAgent(inboundMessage({
      eventId: id(),
      isGroup: true,
      messageId: id(),
      text: "I can only do the 12th",
    }))).toBe(false);

    expect(isAddressedToAgent(inboundMessage({
      eventId: id(),
      isGroup: true,
      mention: "@tripplanner",
      messageId: id(),
      text: "@tripplanner plan us three days in Lisbon",
    }))).toBe(true);
  });

  it("reads the structured mention, not the characters in the text", () => {
    expect(isAddressedToAgent(inboundMessage({
      eventId: id(),
      isGroup: true,
      messageId: id(),
      text: "does @tripplanner even work in here",
    }))).toBe(false);
  });

  it("ignores a mention of another participant", () => {
    expect(isAddressedToAgent(inboundMessage({
      eventId: id(),
      isGroup: true,
      mention: "@calendar",
      messageId: id(),
      text: "@calendar when is Alice free",
    }))).toBe(false);
  });

  it("reads text and link parts and names a shared file", () => {
    expect(messageText([
      { type: "text", value: "look at this", reactions: null },
      { type: "link", value: "https://example.com", reactions: null },
      {
        type: "media",
        id: "01993d50-ef7b-7b37-886b-23fd80c7ec4c",
        url: "https://example.com/a.png",
        filename: "a.png",
        mime_type: "image/png",
        size_bytes: 10,
        reactions: null,
      },
    ])).toBe("look at this\nhttps://example.com\n[attachment]");
  });

  it("prefers a display name over a handle", () => {
    expect(authorName(ALICE)).toBe("Alice");
    expect(authorName({ ...AGENT_HANDLE, display_name: null })).toBe("tripplanner");
  });
});
