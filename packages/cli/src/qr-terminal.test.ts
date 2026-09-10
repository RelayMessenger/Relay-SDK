import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { QR_LINE_PREFIX, renderTerminalQR, terminalQRGrid } from "./qr-terminal.js";

const url = "https://go.staging.relaymessenger.com/owned.dev";

it("pads the module rows to an even count so the last text line is full height", () => {
  const grid = terminalQRGrid(url);
  expect(grid.length % 2).toBe(0);
  expect(grid.length).toBe(renderTerminalQR(url).trimEnd().split("\n").length * 2);
  // The quiet zone stays light on every edge.
  expect(grid[0]!.every(dark => !dark)).toBe(true);
  expect(grid.at(-1)!.every(dark => !dark)).toBe(true);
  expect(grid.every(row => !row[0] && !row.at(-1))).toBe(true);
});

it("gives every line the same visible width and explicit colours at both ends of the code", () => {
  const lines = renderTerminalQR(url).trimEnd().split("\n");
  const widths = new Set(lines.map(line => stripVTControlCharacters(line).length));
  expect(widths.size).toBe(1);
  expect([...widths][0]).toBe(terminalQRGrid(url)[0]!.length);
  expect(lines[0]!.startsWith(QR_LINE_PREFIX)).toBe(true);
  expect(lines.at(-1)!.startsWith(QR_LINE_PREFIX)).toBe(true);
  expect(QR_LINE_PREFIX).toBe("[48;5;231m[38;5;16m");
  expect(lines.every(line => line.endsWith("[0m"))).toBe(true);
});
