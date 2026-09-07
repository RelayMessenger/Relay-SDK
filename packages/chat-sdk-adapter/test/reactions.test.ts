import { describe, expect, it } from "vitest";
import {
  fromRelayReaction,
  toRelayReaction,
} from "../src/index.js";

describe("Relay reactions", () => {
  it.each([
    ["heart", "love"],
    ["thumbs_up", "like"],
    ["thumbs_down", "dislike"],
    ["laugh", "laugh"],
    ["exclamation", "emphasize"],
    ["question", "question"],
  ] as const)("maps %s to Relay %s", (input, type) => {
    expect(toRelayReaction(input)).toEqual({ type });
  });

  it("uses custom_emoji for an arbitrary Unicode emoji", () => {
    expect(toRelayReaction("🦄")).toEqual({
      customEmoji: "🦄",
      type: "custom",
    });
    expect(
      fromRelayReaction({ customEmoji: "🦄", type: "custom" }),
    ).toMatchObject({ rawEmoji: "🦄" });
  });

  it("rejects unknown ASCII reaction names", () => {
    expect(() => toRelayReaction("not_an_emoji")).toThrow(
      /Unicode emoji/,
    );
  });
});
