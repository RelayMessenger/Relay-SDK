import { create } from "qrcode";

/**
 * Compact is the only terminal QR form: two module rows per text line keep
 * the phone step small even in a tall terminal. References in the Relay hub:
 * _sources/hermes-agent/scripts/whatsapp-bridge/bridge.js:425-433 uses small:true;
 * _sources/native-connect/openclaw/src/media/qr-terminal.ts:9-61 uses half-blocks
 * with a one-module margin.
 *
 * Every cell uses an upper half block with the top module's foreground and
 * bottom module's background, so line gaps take the bottom module's colour.
 * Both colours are fixed points of the 256-colour cube (231 and 16), not the
 * theme-dependent ANSI 47 and 40.
 */
export const QR_LIGHT = "\x1b[48;5;231m";
export const QR_DARK = "\x1b[48;5;16m";
/** The same two cube colours as foregrounds, for the top module of a compact cell. */
export const QR_LIGHT_FG = "\x1b[38;5;231m";
export const QR_DARK_FG = "\x1b[38;5;16m";
const RESET = "[0m";
/** Upper half block: the glyph paints the top module, the background paints the bottom one. */
const UPPER_HALF = "▀";

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

/** The whole code in compact form, with a trailing newline for stdout. */
export function renderTerminalQR(value: string): string {
  return `${renderCompact(terminalQRGrid(value))}\n`;
}
