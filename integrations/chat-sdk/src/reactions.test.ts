import { getEmoji } from "chat";
import { describe, expect, it } from "vitest";
import { toRelayReaction } from "./reactions.js";

describe("toRelayReaction", () => {
  it("always sends an emoji character, never a named type", () => {
    expect(toRelayReaction(getEmoji("heart"))).toEqual({ type: "emoji", emoji: "❤️" });
    expect(toRelayReaction(getEmoji("thumbs_up"))).toEqual({ type: "emoji", emoji: "👍" });
    expect(toRelayReaction(getEmoji("laugh"))).toEqual({ type: "emoji", emoji: "😂" });
  });

  it("passes a literal character straight through", () => {
    expect(toRelayReaction("👍")).toEqual({ type: "emoji", emoji: "👍" });
    expect(toRelayReaction("❤️")).toEqual({ type: "emoji", emoji: "❤️" });
  });

  it("normalizes a modified character, so an add and a remove match", () => {
    // Relay deletes a reaction by exact emoji match, so a toned add and a bare
    // remove would leave the reaction standing and still answer 200. Both
    // paths run through this one function, so both send the same character.
    expect(toRelayReaction("👍🏽")).toEqual(toRelayReaction("👍"));
    expect(toRelayReaction("👍🏽")).toEqual({ type: "emoji", emoji: "👍" });
  });

  it("normalizes a character it does not know to its own bare form", () => {
    expect(toRelayReaction("🫶🏽")).toEqual(toRelayReaction("🫶"));
  });

  it("accepts a shortcode and the EmojiValue placeholder form", () => {
    expect(toRelayReaction(":thumbs_up:")).toEqual({ type: "emoji", emoji: "👍" });
    expect(toRelayReaction(String(getEmoji("heart")))).toEqual({ type: "emoji", emoji: "❤️" });
  });

  it("accepts a Slack alias", () => {
    expect(toRelayReaction(":+1:")).toEqual({ type: "emoji", emoji: "👍" });
  });

  it("sends an arbitrary emoji unchanged", () => {
    expect(toRelayReaction("🔥")).toEqual({ type: "emoji", emoji: "🔥" });
    expect(toRelayReaction(getEmoji("rocket"))).toEqual({
      type: "emoji",
      emoji: "🚀",
    });
  });

  it("refuses a name it cannot resolve to a character", () => {
    expect(() => toRelayReaction(":not_a_real_emoji:")).toThrow(/unknown emoji name/);
  });
});
