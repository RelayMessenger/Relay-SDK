import { describe, expect, it } from "vitest";
import { colourDepth, palette } from "./ui-colour.js";

const ESC = "[";
const BLUE_TRUECOLOR = `${ESC}38;2;10;132;255m`;
const BLUE_256 = `${ESC}38;5;33m`;
/** clack's own success hue: SGR 32, its bright form 92, and the 256-cube cells Terminal.app shows the same way. */
const GREEN = /\[(32|92|38;5;(2|10|22|28|34|40|46))m/u;

describe("Relay terminal colour", () => {
  it("paints Relay blue in 24-bit when COLORTERM says truecolor", () => {
    expect(palette({ env: { COLORTERM: "truecolor" }, isTTY: true }).blue("Relay")).toBe(`${BLUE_TRUECOLOR}Relay${ESC}39m`);
    expect(colourDepth({ env: { COLORTERM: "24bit" }, isTTY: true })).toBe("truecolor");
    expect(colourDepth({ env: { FORCE_COLOR: "3" }, isTTY: false })).toBe("truecolor");
  });

  it("falls back to the 256-colour cube on a plain terminal", () => {
    expect(palette({ env: { TERM: "xterm-256color" }, isTTY: true }).blue("Relay")).toBe(`${BLUE_256}Relay${ESC}39m`);
    expect(colourDepth({ env: { FORCE_COLOR: "1" }, isTTY: false })).toBe("256");
  });

  it("paints nothing under NO_COLOR, FORCE_COLOR=0, a dumb terminal, or off a terminal", () => {
    expect(palette({ env: { NO_COLOR: "1", COLORTERM: "truecolor" }, isTTY: true }).blue("Relay")).toBe("Relay");
    expect(colourDepth({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe("none");
    expect(colourDepth({ env: { TERM: "dumb" }, isTTY: true })).toBe("none");
    expect(colourDepth({ env: { COLORTERM: "truecolor" }, isTTY: false })).toBe("none");
    // The empty string is "not set" for NO_COLOR (no-color.org), so colour stays.
    expect(colourDepth({ env: { NO_COLOR: "" }, isTTY: true })).toBe("256");
  });

  it("dim, red and underline are the standard SGR pairs, and none of the palette is clack's success hue", () => {
    const p = palette({ env: { COLORTERM: "truecolor" }, isTTY: true });
    expect(p.dim("x")).toBe(`${ESC}2mx${ESC}22m`);
    expect(p.red("x")).toBe(`${ESC}31mx${ESC}39m`);
    expect(p.underline("x")).toBe(`${ESC}4mx${ESC}24m`);
    // The cursor block a placeholder starts with (clack-theme.ts, text).
    expect(p.inverse("x")).toBe(`${ESC}7mx${ESC}27m`);
    for (const painted of [p.blue("x"), p.dim("x"), p.red("x"), p.underline("x"), p.inverse("x")]) expect(painted).not.toMatch(GREEN);
  });
});
