import { create } from "qrcode";

/**
 * Terminal QR code, one renderer for every call site, in two standard sizes.
 *
 * Full cells are the `qrcode` package's own big-mode terminal shape
 * (node_modules/qrcode/lib/renderer/terminal/terminal.js:10-30, the shape
 * `qrcode-terminal` prints too): every module is two spaces painted with a
 * background colour, one text line per module row. It is the better form,
 * because a half-block glyph does not fill the cell height in Terminal.app and
 * leaves a hairline gap through every row (owner, 2026-09-11: "weird white
 * lines in the middle"). It is also twice as tall, and a code that runs off the
 * screen cannot be scanned at all.
 *
 * Compact is that package's small mode: two module rows per text line drawn
 * with the half-block glyphs, half the height and half the width. It is what
 * this renderer falls back to, and only when the full code does not fit the
 * rows the caller has. Both forms carry the same one-module quiet zone and the
 * same two colours, so the only difference between them is size.
 *
 * The two colours are ours, not the library's. The library paints with ANSI 47
 * and 40, which a light theme repaints gray (owner, 2026-09-09). 231 and 16 are
 * fixed points of the 256-colour cube, which no theme moves.
 */
export const QR_LIGHT = "[48;5;231m";
export const QR_DARK = "[48;5;16m";
/** Compact paints the glyph, not the cell: the same black, as a foreground. */
export const QR_GLYPH = "[38;5;16m";
/** Every compact line opens with the full colour pair, so no cell is left bare. */
export const QR_LINE_PREFIX = QR_LIGHT + QR_GLYPH;
const RESET = "[0m";
/** One full-cell module is two character cells wide, so the printed code is square. */
const MODULE = "  ";
const BLOCKS = { "00": " ", "01": "▄", "10": "▀", "11": "█" } as const;

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
 * Two module rows per text line. The row count is padded even with a light row,
 * because an odd count ends the code on a lone half-block row that reads as cut
 * off (the defect the 2026-09-09 renderer fixed).
 */
function renderCompact(grid: readonly (readonly boolean[])[]): string {
  const rows = grid.length % 2 ? [...grid, grid[0]!.map(() => false)] : [...grid];
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? []; const bottom = rows[y + 1] ?? [];
    const cells = top.map((dark, x) => BLOCKS[`${dark ? 1 : 0}${bottom[x] ? 1 : 0}` as keyof typeof BLOCKS]);
    lines.push(QR_LINE_PREFIX + cells.join("") + RESET);
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
