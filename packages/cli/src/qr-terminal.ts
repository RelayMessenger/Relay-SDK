import { toQR } from "toqr";

/** Fixed black/white rather than the terminal theme's ANSI palette. */
export const QR_DARK = "\x1b[48;5;16m";
export const QR_LIGHT_FG = "\x1b[38;5;231m";
const RESET = "\x1b[0m";
export const QR_QUIET_ZONE = 4;

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
 * Keep the one-column BMP glyphs on every terminal; no font-specific sextants.
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

/** The whole code in compact form, with a trailing newline for stdout. */
export function renderTerminalQR(value: string): string {
  return `${renderCompact(terminalQRGrid(value))}\n`;
}
