import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { QR_DARK, QR_LIGHT, renderTerminalQR, terminalQRGrid } from "./qr-terminal.js";

const url = "https://go.staging.relaymessenger.com/owned.dev";
const lines = (): string[] => renderTerminalQR(url).trimEnd().split("\n");

it("prints one text line per module row and no half-block glyph", () => {
  // A half-block glyph does not fill the cell height, so it draws a hairline gap
  // through every text row. Full background-coloured cells cannot.
  expect(renderTerminalQR(url)).not.toMatch(/[▀▄█]/u);
  expect(lines().length).toBe(terminalQRGrid(url).length);
});

it("gives every line the same visible width, two cells per module", () => {
  const widths = new Set(lines().map((line) => stripVTControlCharacters(line).length));
  expect(widths.size).toBe(1);
  expect([...widths][0]).toBe(terminalQRGrid(url)[0]!.length * 2);
  expect(lines().every((line) => stripVTControlCharacters(line).trim() === "")).toBe(true);
});

it("keeps a one-module light quiet zone on every edge", () => {
  const grid = terminalQRGrid(url);
  expect(grid[0]!.every((dark) => !dark)).toBe(true);
  expect(grid.at(-1)!.every((dark) => !dark)).toBe(true);
  expect(grid.every((row) => !row[0] && !row.at(-1))).toBe(true);
  // The quiet rows print as light cells, so the code never touches the text.
  expect(lines()[0]!.includes(QR_DARK)).toBe(false);
  expect(lines().at(-1)!.includes(QR_DARK)).toBe(false);
});

it("names both colours from the 256-colour cube, never ANSI 7 or 0", () => {
  expect(QR_LIGHT).toBe("\u001B[48;5;231m");
  expect(QR_DARK).toBe("\u001B[48;5;16m");
  const painted = renderTerminalQR(url);
  expect(painted).toContain(QR_LIGHT);
  expect(painted).toContain(QR_DARK);
  // 47 and 40 are the library's own colours, which a light theme repaints gray.
  expect(painted).not.toMatch(/\u001B\[[34][07]m/u);
});
