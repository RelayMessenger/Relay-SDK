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

  it("keeps a skin tone modifier on the character it sends", () => {
    expect(toRelayReaction("👍🏽")).toEqual({ type: "emoji", emoji: "👍🏽" });
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
