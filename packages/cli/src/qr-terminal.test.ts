import { stripVTControlCharacters } from "node:util";
import { create } from "qrcode";
import { expect, it } from "vitest";
import {
  QR_DARK, QR_DARK_FG, QR_LIGHT, QR_LIGHT_FG,
  renderTerminalQR, terminalQRGrid,
} from "./qr-terminal.js";

const url = "https://staging.relayapp.im/@my_agent";
const COMPACT_LINES = 16;
const compact = (): string[] => renderTerminalQR(url).trimEnd().split("\n");

/**
 * The painted compact text read back as dark/light modules, two rows per line:
 * the foreground code is the top module, the background code the bottom one.
 */
const COMPACT_CELL = /\x1b\[38;5;(231|16)m\x1b\[48;5;(231|16)m▀/gu;
function readCompact(painted: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of painted.trimEnd().split("\n")) {
    const cells = [...line.matchAll(COMPACT_CELL)];
    expect(cells.join("")).not.toBe("");
    rows.push(cells.map((cell) => cell[1] === "16"));
    rows.push(cells.map((cell) => cell[2] === "16"));
  }
  return rows;
}

/** The encoder's own modules, which the renderer must reproduce exactly. */
function encoded(): boolean[][] {
  const { size, data } = create(url).modules as { size: number; data: ArrayLike<number | boolean> };
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => Boolean(data[y * size + x])));
}

it("prints a 29-module code in 16 lines and 31 visible columns", () => {
  expect(create(url).modules.size).toBe(29);
  expect(compact()).toHaveLength(16);
  expect(compact().map(line => stripVTControlCharacters(line).length)).toEqual(Array(16).fill(31));
});

it("paints every cell and pads to an even number of module rows", () => {
  const painted = renderTerminalQR(url);
  // Every cell is the upper half block with BOTH a foreground (top module) and
  // a background (bottom module), so no pixel of the cell is left to the
  // terminal's own colour: the line gap takes the bottom module's colour.
  expect(compact().every((line) => line.endsWith("\x1b[0m"))).toBe(true);
  for (const line of compact()) {
    const cells = [...line.matchAll(COMPACT_CELL)];
    expect(cells.length).toBe(terminalQRGrid(url)[0]!.length);
    expect(cells.map((cell) => cell[0]).join("") + "\x1b[0m").toBe(line);
  }
  // Two module rows per line, so the padded row count is even and nothing is cut off.
  expect(readCompact(painted).length % 2).toBe(0);
  expect(readCompact(painted).length).toBe(COMPACT_LINES * 2);
  expect(QR_DARK_FG).toBe("\x1b[38;5;16m");
  expect(QR_LIGHT_FG).toBe("\x1b[38;5;231m");
});

it("paints each compact cell pair by colour, never by glyph shape", () => {
  const grid = terminalQRGrid(url);
  const cell = (y: number, x: number): string => {
    const line = compact()[Math.floor(y / 2)]!;
    return [...line.matchAll(COMPACT_CELL)][x]![0];
  };
  const pairs = { "11": QR_DARK_FG + QR_DARK + "▀", "00": QR_LIGHT_FG + QR_LIGHT + "▀",
    "10": QR_DARK_FG + QR_LIGHT + "▀", "01": QR_LIGHT_FG + QR_DARK + "▀" };
  const seen = new Set<string>();
  for (let y = 0; y + 1 < grid.length; y += 2) {
    for (let x = 0; x < grid[0]!.length; x += 1) {
      const key = `${grid[y]![x] ? 1 : 0}${grid[y + 1]![x] ? 1 : 0}` as keyof typeof pairs;
      seen.add(key);
      expect(cell(y, x)).toBe(pairs[key]);
    }
  }
  expect(seen.size).toBe(4);
  // The old form drew dark glyphs on a light ground; a plain " ", "▄" or "█"
  // reads as a gap or a glyph that does not fill its cell.
  const text = renderTerminalQR(url);
  expect(text).not.toMatch(/[ ▄█]/u);
  expect(text).not.toMatch(/\x1b\[38;5;16m▀/u);
});

it("reproduces the encoder's own modules", () => {
  const modules = encoded();
  for (const read of [readCompact(renderTerminalQR(url))]) {
    // Strip the quiet zone, and for the compact form the light row that pads it even.
    const inner = read.slice(1, 1 + modules.length).map((row) => row.slice(1, 1 + modules.length));
    expect(inner).toEqual(modules);
    // The quiet zone is light on every edge in the rendering.
    expect(read[0]!.every((dark) => !dark)).toBe(true);
    expect(read.slice(0, 1 + modules.length + 1).every((row) => !row[0] && !row[modules.length + 1])).toBe(true);
    expect(read[modules.length + 1]!.every((dark) => !dark)).toBe(true);
  }
});

it("keeps a one-module light quiet zone on every edge", () => {
  const grid = terminalQRGrid(url);
  expect(grid[0]!.every((dark) => !dark)).toBe(true);
  expect(grid.at(-1)!.every((dark) => !dark)).toBe(true);
  expect(grid.every((row) => !row[0] && !row.at(-1))).toBe(true);
  // The quiet rows print as light cells, so the code never touches the text.
  expect(compact()[0]!.includes(QR_DARK_FG)).toBe(false);
  expect(compact().at(-1)!.includes(QR_DARK)).toBe(false);
});

it("names both colours from the 256-colour cube, never ANSI 7 or 0", () => {
  expect(QR_LIGHT).toBe("[48;5;231m");
  expect(QR_DARK).toBe("[48;5;16m");
  // 47 and 40 are the library's own colours, which a light theme repaints gray.
  for (const painted of [renderTerminalQR(url)]) {
    expect(painted).toContain(QR_LIGHT);
    expect(painted).not.toMatch(/\[[34][07]m/u);
  }
});
