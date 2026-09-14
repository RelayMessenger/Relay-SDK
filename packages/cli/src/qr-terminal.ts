import { create } from "qrcode";

/**
 * Terminal QR code, one renderer for every call site, in two standard sizes.
 *
 * Full cells are the `qrcode` package's own big-mode terminal shape
 * (node_modules/qrcode/lib/renderer/terminal/terminal.js:10-30, the shape
 * `qrcode-terminal` prints too): every module is two spaces painted with a
 * background colour, one text line per module row. It is twice as tall as
 * compact, and a code that runs off the screen cannot be scanned at all, so it
 * is used only while it fits the rows the caller has.
 *
 * Compact is two module rows per text line, the shape `qrencode -t ANSIUTF8`
 * prints, and it paints the CELL, never the glyph: every cell is the `▀` glyph
 * with the foreground set to the top module's colour and the background set to
 * the bottom module's colour. A glyph does not fill the cell height, so the
 * earlier compact form (dark `▀ ▄ █` glyphs on a light background) left a
 * hairline of light background between every text line, through every dark
 * module (owner, 2026-09-12: "really hard to scan because of the white lines
 * on it"). With the cell painted, every pixel is either glyph or background,
 * and the line gap takes the bottom module's colour, which is what belongs
 * there. Both forms carry the same one-module quiet zone and the same two
 * colours, so the only difference between them is size.
 *
 * The two colours are ours, not the library's. The library paints with ANSI 47
 * and 40, which a light theme repaints gray (owner, 2026-09-09). 231 and 16 are
 * fixed points of the 256-colour cube, which no theme moves.
 */
export const QR_LIGHT = "\x1b[48;5;231m";
export const QR_DARK = "\x1b[48;5;16m";
/** The same two cube colours as foregrounds, for the top module of a compact cell. */
export const QR_LIGHT_FG = "\x1b[38;5;231m";
export const QR_DARK_FG = "\x1b[38;5;16m";
const RESET = "[0m";
/** One full-cell module is two character cells wide, so the printed code is square. */
const MODULE = "  ";
/** Upper half block: the glyph paints the top module, the background paints the bottom one. */
const UPPER_HALF = "▀";

export type TerminalQRForm = "full" | "compact";
export interface TerminalQROptions {
  /** Text lines the caller can give the code. Undefined means unlimited. */
  rows?: number | undefined;
}

interface QRModules { size: number; data: ArrayLike<number | boolean> }

/** Dark modules as rows, with a one-module light quiet zone on every edge. */
export function terminalQRGrid(value: string): boolean[][] {
  const { size, data } = create(value).modules as QRModules;
  const quiet = (): boolean[] => Array.from({ length: size + 2 }, () => false);
  return [
    quiet(),
    ...Array.from({ length: size }, (_, y) =>
      [false, ...Array.from({ length: size }, (_, x) => Boolean(data[y * size + x])), false]),
    quiet(),
  ];
}

/** Text lines a form needs: one per module row, or one per two module rows. */
export function terminalQRLines(value: string, form: TerminalQRForm): number {
  const height = terminalQRGrid(value).length;
  return form === "full" ? height : Math.ceil(height / 2);
}

/**
 * Rows left for the code after the lines a scrolling command prints around it.
 * Undefined rows means the output is not a terminal, so nothing limits the code.
 */
export function terminalQRRowsLeft(rows: number | undefined, surroundingLines: number): number | undefined {
  return rows === undefined ? undefined : Math.max(0, rows - surroundingLines);
}

/** Full cells while they fit the rows available, compact below that. Compact is the floor. */
export function terminalQRForm(value: string, rows?: number): TerminalQRForm {
  return rows === undefined || rows >= terminalQRLines(value, "full") ? "full" : "compact";
}

/** One text line per module row, every module two background-coloured spaces. */
function renderFull(grid: readonly (readonly boolean[])[]): string {
  return grid
    .map((row) => row.map((dark) => `${dark ? QR_DARK : QR_LIGHT}${MODULE}${RESET}`).join(""))
    .join("\n");
}

/**
 * Two module rows per text line, every cell painted with both colours: the
 * foreground is the top module, the background is the bottom module. The row
 * count is padded even with a light row, because an odd count ends the code on
 * a lone half-block row that reads as cut off (the defect the 2026-09-09
 * renderer fixed).
 */
function renderCompact(grid: readonly (readonly boolean[])[]): string {
  const rows = grid.length % 2 ? [...grid, grid[0]!.map(() => false)] : [...grid];
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? []; const bottom = rows[y + 1] ?? [];
    const cells = top.map((dark, x) =>
      `${dark ? QR_DARK_FG : QR_LIGHT_FG}${bottom[x] ? QR_DARK : QR_LIGHT}${UPPER_HALF}`);
    lines.push(cells.join("") + RESET);
  }
  return lines.join("\n");
}

/**
 * The whole code, always on screen. `rows` is the number of text lines the
 * caller can give it; leave it out when the caller has no limit (a plain stdout
 * that is not a live view).
 */
export function renderTerminalQR(value: string, options: TerminalQROptions = {}): string {
  const grid = terminalQRGrid(value);
  const painted = terminalQRForm(value, options.rows) === "full" ? renderFull(grid) : renderCompact(grid);
  return `${painted}\n`;
}
