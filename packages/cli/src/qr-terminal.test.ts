import { stripVTControlCharacters } from "node:util";
import { create } from "qrcode";
import { expect, it } from "vitest";
import {
  QR_DARK, QR_DARK_FG, QR_LIGHT, QR_LIGHT_FG,
  renderTerminalQR, terminalQRForm, terminalQRGrid, terminalQRLines, terminalQRRowsLeft,
} from "./qr-terminal.js";

const url = "https://go.staging.relaymessenger.com/owned.dev";
/** Measured, not assumed: 33 modules and a one-module quiet zone on each edge. */
const FULL_LINES = 35;
const COMPACT_LINES = 18;
const lines = (rows?: number): string[] => renderTerminalQR(url, { rows }).trimEnd().split("\n");
const full = (): string[] => lines();
const compact = (): string[] => lines(FULL_LINES - 1);

/** The painted full-cell text read back as dark/light modules. */
function readFull(painted: string): boolean[][] {
  return painted.trimEnd().split("\n").map((line) => {
    const cells = [...line.matchAll(/\[48;5;(231|16)m {2}\[0m/gu)];
    expect(cells.join("")).not.toBe("");
    return cells.map((cell) => cell[1] === "16");
  });
}

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

/** The encoder's own modules, which either form must reproduce exactly. */
function encoded(): boolean[][] {
  const { size, data } = create(url).modules as { size: number; data: ArrayLike<number | boolean> };
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => Boolean(data[y * size + x])));
}

it("switches to the compact form exactly one row below what the full code needs", () => {
  expect(terminalQRLines(url, "full")).toBe(FULL_LINES);
  expect(terminalQRLines(url, "compact")).toBe(COMPACT_LINES);
  // The threshold, both sides of it, and the unlimited case a non-TTY gets.
  expect(terminalQRForm(url, FULL_LINES)).toBe("full");
  expect(terminalQRForm(url, FULL_LINES - 1)).toBe("compact");
  expect(terminalQRForm(url, undefined)).toBe("full");
  expect(terminalQRForm(url, 0)).toBe("compact");
  expect(full().length).toBe(FULL_LINES);
  expect(compact().length).toBe(COMPACT_LINES);
  expect(renderTerminalQR(url, { rows: FULL_LINES })).toBe(renderTerminalQR(url));
});

it("prints full cells when the rows are there: no half-block glyph, both cube colours", () => {
  // A half-block glyph does not fill the cell height, so it draws a hairline gap
  // through every text row. Full background-coloured cells cannot.
  const painted = renderTerminalQR(url, { rows: FULL_LINES });
  expect(painted).not.toMatch(/[▀▄█]/u);
  expect(painted).toContain(QR_LIGHT);
  expect(painted).toContain(QR_DARK);
  expect(full().length).toBe(terminalQRGrid(url).length);
});

it("prints the compact form below the threshold: every cell painted, an even number of module rows", () => {
  const painted = renderTerminalQR(url, { rows: FULL_LINES - 1 });
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
  const text = renderTerminalQR(url, { rows: FULL_LINES - 1 });
  expect(text).not.toMatch(/[ ▄█]/u);
  expect(text).not.toMatch(/\x1b\[38;5;16m▀/u);
});

it("reproduces the encoder's own modules in both forms", () => {
  const modules = encoded();
  for (const read of [readFull(renderTerminalQR(url)), readCompact(renderTerminalQR(url, { rows: 0 }))]) {
    // Strip the quiet zone, and for the compact form the light row that pads it even.
    const inner = read.slice(1, 1 + modules.length).map((row) => row.slice(1, 1 + modules.length));
    expect(inner).toEqual(modules);
    // The quiet zone is light on every edge in both forms.
    expect(read[0]!.every((dark) => !dark)).toBe(true);
    expect(read.slice(0, 1 + modules.length + 1).every((row) => !row[0] && !row[modules.length + 1])).toBe(true);
    expect(read[modules.length + 1]!.every((dark) => !dark)).toBe(true);
  }
});

it("gives every line the same visible width: two cells per module, one in the compact form", () => {
  const width = (list: string[]): Set<number> =>
    new Set(list.map((line) => stripVTControlCharacters(line).length));
  expect(width(full()).size).toBe(1);
  expect([...width(full())][0]).toBe(terminalQRGrid(url)[0]!.length * 2);
  expect(width(compact()).size).toBe(1);
  expect([...width(compact())][0]).toBe(terminalQRGrid(url)[0]!.length);
  expect(full().every((line) => stripVTControlCharacters(line).trim() === "")).toBe(true);
});

it("keeps a one-module light quiet zone on every edge", () => {
  const grid = terminalQRGrid(url);
  expect(grid[0]!.every((dark) => !dark)).toBe(true);
  expect(grid.at(-1)!.every((dark) => !dark)).toBe(true);
  expect(grid.every((row) => !row[0] && !row.at(-1))).toBe(true);
  // The quiet rows print as light cells, so the code never touches the text.
  expect(full()[0]!.includes(QR_DARK)).toBe(false);
  expect(full().at(-1)!.includes(QR_DARK)).toBe(false);
});

it("names both colours from the 256-colour cube, never ANSI 7 or 0", () => {
  expect(QR_LIGHT).toBe("[48;5;231m");
  expect(QR_DARK).toBe("[48;5;16m");
  // 47 and 40 are the library's own colours, which a light theme repaints gray.
  for (const painted of [renderTerminalQR(url), renderTerminalQR(url, { rows: 0 })]) {
    expect(painted).toContain(QR_LIGHT);
    expect(painted).not.toMatch(/\[[34][07]m/u);
  }
});

it("leaves the code unlimited when the output is not a terminal", () => {
  expect(terminalQRRowsLeft(undefined, 4)).toBeUndefined();
  expect(terminalQRRowsLeft(40, 4)).toBe(36);
  expect(terminalQRRowsLeft(2, 4)).toBe(0);
});
