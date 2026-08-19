import { getEmoji } from "chat";
import { describe, expect, it } from "vitest";
import { toRelayReaction } from "./reactions.js";

describe("toRelayReaction", () => {
  it("maps the six Relay tapbacks by well-known name", () => {
    expect(toRelayReaction(getEmoji("heart"))).toEqual({ type: "love" });
    expect(toRelayReaction(getEmoji("thumbs_up"))).toEqual({ type: "like" });
    expect(toRelayReaction(getEmoji("thumbs_down"))).toEqual({ type: "dislike" });
    expect(toRelayReaction(getEmoji("laugh"))).toEqual({ type: "laugh" });
    expect(toRelayReaction(getEmoji("exclamation"))).toEqual({ type: "emphasize" });
    expect(toRelayReaction(getEmoji("question"))).toEqual({ type: "question" });
  });

  it("maps a literal tapback character onto its named type", () => {
    expect(toRelayReaction("👍")).toEqual({ type: "like" });
    expect(toRelayReaction("❤️")).toEqual({ type: "love" });
  });

  it("ignores a skin tone modifier when matching", () => {
    expect(toRelayReaction("👍🏽")).toEqual({ type: "like" });
  });

  it("accepts a shortcode and the EmojiValue placeholder form", () => {
    expect(toRelayReaction(":thumbs_up:")).toEqual({ type: "like" });
    expect(toRelayReaction(String(getEmoji("heart")))).toEqual({ type: "love" });
  });

  it("accepts a Slack alias", () => {
    expect(toRelayReaction(":+1:")).toEqual({ type: "like" });
  });

  it("sends anything else as a plain emoji reaction", () => {
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
