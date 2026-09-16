import { toQR } from "toqr";

/** Fixed black/white rather than the terminal theme's ANSI palette. */
export const QR_DARK = "\x1b[48;5;16m";
export const QR_LIGHT = "\x1b[48;5;231m";
export const QR_LIGHT_FG = "\x1b[38;5;231m";
const RESET = "\x1b[0m";
export const QR_QUIET_ZONE = 4;

interface TerminalQRViewport {
  columns?: number | undefined;
  rows?: number | undefined;
}
interface TerminalQROptions extends TerminalQRViewport {
  terminalProgram?: string | undefined;
}
export class TerminalQRSizeError extends Error {
  constructor() { super("Enlarge terminal to show the QR."); }
}

/** Dark modules, surrounded by the four-module quiet zone required by QR. */
export function terminalQRGrid(value: string): boolean[][] {
  const data = toQR(value);
  const size = Math.sqrt(data.length);
  const extent = size + QR_QUIET_ZONE * 2;
  return Array.from({ length: extent }, (_, y) =>
    Array.from({ length: extent }, (_, x) => {
      const row = y - QR_QUIET_ZONE; const column = x - QR_QUIET_ZONE;
      return row >= 0 && column >= 0 && row < size && column < size
        ? Boolean(data[row * size + column])
        : false;
    }));
}

/**
 * Expo's compact strategy: choose a full/half block or a space for each pair
 * of module rows. One color pair per line, not two color changes per cell.
 * Reference: expo/expo packages/@expo/cli/src/utils/qr.ts at f6f5af06b95c.
 * Use BMP block characters, not font-specific sextants.
 */
function renderCompact(grid: readonly (readonly boolean[])[]): string {
  const lines: string[] = [];
  const glyphs = ["█", "▀", "▄", " "] as const;
  for (let y = 0; y < grid.length; y += 2) {
    const row = grid[y]!.map((top, x) => {
      const bottom = grid[y + 1]?.[x] ?? false;
      return glyphs[(Number(top) << 1) | Number(bottom)];
    }).join("");
    lines.push(QR_DARK + QR_LIGHT_FG + row + RESET);
  }
  return lines.join("\n");
}

/** Background-colored spaces have no font-glyph gaps in Apple Terminal. */
function renderSolid(grid: readonly (readonly boolean[])[]): string {
  return grid.map(row => {
    let previous: boolean | undefined;
    let line = "";
    for (const dark of row) {
      if (dark !== previous) line += dark ? QR_DARK : QR_LIGHT;
      line += "  ";
      previous = dark;
    }
    return line + RESET;
  }).join("\n");
}

/** Watch owns its viewport checks so a cached QR can appear after a resize. */
export function renderTerminalQR(value: string, options: TerminalQROptions = {}): string {
  const grid = terminalQRGrid(value);
  const solid = (options.terminalProgram ?? process.env.TERM_PROGRAM) === "Apple_Terminal";
  const columns = grid.length * (solid ? 2 : 1);
  const rows = solid ? grid.length : Math.ceil(grid.length / 2);
  if ((options.columns !== undefined && columns > options.columns)
    || (options.rows !== undefined && rows > options.rows)) throw new TerminalQRSizeError();
  return `${solid ? renderSolid(grid) : renderCompact(grid)}\n`;
}

/** One-shot output must fit without wrapping; leave room for its link/cursor. */
export function renderTerminalQRForOutput(value: string, output: TerminalQRViewport = process.stdout): string {
  return renderTerminalQR(value, {
    columns: output.columns,
    rows: output.rows === undefined ? undefined : Math.max(0, output.rows - 2),
  });
}
