import { createRequire } from "node:module";

/**
 * Terminal QR code, one renderer for every call site.
 *
 * The library's `{ type: "terminal", small: true }` output has two defects the
 * owner saw on a light Terminal theme (2026-09-09): it paints the field with
 * ANSI colour 7, which light themes draw as gray, and it walks module rows two
 * per text line from -1 to size, an odd count, so the last line is a lone
 * half-block row that looks like the code was cut off. This renderer keeps the
 * compact two-rows-per-line form, pads the module rows to an even count, and
 * names both colours from the fixed 256-colour cube (16 = black, 231 = white),
 * which no theme repaints.
 */
const BACKGROUND = "[48;5;231m";
const FOREGROUND = "[38;5;16m";
const RESET = "[0m";
export const QR_LINE_PREFIX = BACKGROUND + FOREGROUND;

interface QRModules { size: number; data: ArrayLike<number | boolean> }

function qrModules(value: string): QRModules {
  const qr = createRequire(import.meta.url)("qrcode") as { create(text: string): { modules: QRModules } };
  return qr.create(value).modules;
}

/** Dark modules as rows, with a one-module light quiet zone and an even row count. */
export function terminalQRGrid(value: string): boolean[][] {
  const { size, data } = qrModules(value);
  const width = size + 2;
  const light = (): boolean[] => Array.from({ length: width }, () => false);
  const rows: boolean[][] = [light()];
  for (let y = 0; y < size; y++) {
    rows.push([false, ...Array.from({ length: size }, (_, x) => Boolean(data[y * size + x])), false]);
  }
  rows.push(light());
  if (rows.length % 2) rows.push(light());
  return rows;
}

const BLOCKS = { "00": " ", "01": "▄", "10": "▀", "11": "█" } as const;

/** Two module rows per text line; every line starts with the same explicit colours and ends with a reset. */
export function renderTerminalQR(value: string): string {
  const rows = terminalQRGrid(value);
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? []; const bottom = rows[y + 1] ?? [];
    const cells = top.map((dark, x) => BLOCKS[`${dark ? 1 : 0}${bottom[x] ? 1 : 0}` as keyof typeof BLOCKS]);
    lines.push(QR_LINE_PREFIX + cells.join("") + RESET);
  }
  return lines.join("\n") + "\n";
}
