import { create } from "qrcode";

/**
 * Terminal QR code, one renderer for every call site.
 *
 * The shape is the `qrcode` package's own big-mode terminal renderer
 * (node_modules/qrcode/lib/renderer/terminal/terminal.js:10-30, the shape
 * `qrcode-terminal` prints too): every module is two spaces painted with a
 * background colour, one text line per module row, and a one-module quiet zone
 * on every edge. No half-block glyph is ever printed. A glyph does not fill the
 * cell height in Terminal.app, so a renderer that walks two module rows per text
 * line leaves a hairline gap through the middle of every row (owner, 2026-09-11:
 * "weird white lines in the middle").
 *
 * The two colours are ours, not the library's. The library paints with ANSI 47
 * and 40, which a light theme repaints gray (owner, 2026-09-09). 231 and 16 are
 * fixed points of the 256-colour cube, which no theme moves.
 */
export const QR_LIGHT = "\u001B[48;5;231m";
export const QR_DARK = "\u001B[48;5;16m";
const RESET = "\u001B[0m";
/** One module is two character cells wide, so the printed code is square. */
const MODULE = "  ";

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

/** One text line per module row, every module two background-coloured spaces. */
export function renderTerminalQR(value: string): string {
  const lines = terminalQRGrid(value)
    .map((row) => row.map((dark) => `${dark ? QR_DARK : QR_LIGHT}${MODULE}${RESET}`).join(""));
  return `${lines.join("\n")}\n`;
}
