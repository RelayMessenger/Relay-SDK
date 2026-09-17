import { stripVTControlCharacters } from "node:util";
import jsQR from "jsqr";
import { toQR } from "toqr";
import { afterEach, expect, it, vi } from "vitest";
import {
  QR_DARK, QR_LIGHT_FG, QR_QUIET_ZONE, TerminalQRSizeError,
  renderTerminalQR, renderTerminalQRForOutput, terminalQRGrid,
} from "./qr-terminal.js";

afterEach(() => vi.unstubAllEnvs());
const urls = [
  "https://go.relayapp.im/@my_agent",
  "https://go.staging.relayapp.im/@my_agent",
  `https://go.relayapp.im/@${"a".repeat(32)}`,
  `https://go.staging.relayapp.im/@${"a".repeat(32)}`,
];
const plainLines = (value: string): string[] =>
  stripVTControlCharacters(renderTerminalQR(value, { terminalProgram: "ghostty" })).trimEnd().split("\n");

/** Read the actual printed glyphs, not the encoder's input matrix. */
function renderedModules(value: string, terminalProgram = "ghostty"): boolean[][] {
  if (terminalProgram === "Apple_Terminal") {
    return renderTerminalQR(value, { terminalProgram }).trimEnd().split("\n").map(line => {
      const runs = [...line.matchAll(/\x1b\[48;5;(16|231)m( +)/gu)];
      expect(runs.map(run => run[0]).join("") + "\x1b[0m").toBe(line);
      return runs.flatMap(run => {
        expect(run[2]!.length % 2).toBe(0);
        return Array.from({ length: run[2]!.length / 2 }, () => run[1] === "16");
      });
    });
  }
  const modules: boolean[][] = [];
  const pairs: Record<string, readonly [boolean, boolean]> = {
    "█": [false, false], "▀": [false, true], "▄": [true, false], " ": [true, true],
  };
  for (const line of plainLines(value)) {
    const top: boolean[] = []; const bottom: boolean[] = [];
    for (const glyph of line) {
      const pair = pairs[glyph];
      if (!pair) throw new Error(`Unexpected terminal QR glyph: ${glyph}`);
      top.push(pair[0]); bottom.push(pair[1]);
    }
    modules.push(top, bottom);
  }
  return modules;
}

/** Rasterize the printed cells for a decoder independent of toqr. */
function decoded(value: string, terminalProgram = "ghostty"): string | undefined {
  const modules = renderedModules(value, terminalProgram);
  const scale = 8;
  const width = modules[0]!.length * scale; const height = modules.length * scale;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = modules[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      pixels.set([color, color, color, 255], offset);
    }
  }
  return jsQR(pixels, width, height, { inversionAttempts: "dontInvert" })?.data;
}

it.each(urls)("decodes the printed QR back to its public link: %s", (url) => {
  expect(decoded(url)).toBe(url);
});

it.each(urls)("preserves every encoded module and pads the last row: %s", (url) => {
  const grid = terminalQRGrid(url);
  const read = renderedModules(url);
  expect(read.slice(0, grid.length)).toEqual(grid);
  expect(read.length % 2).toBe(0);
  expect(read.at(-1)!.every((dark) => !dark)).toBe(true);
  const data = toQR(url); const size = Math.sqrt(data.length);
  const modules = read.slice(QR_QUIET_ZONE, QR_QUIET_ZONE + size)
    .map(row => row.slice(QR_QUIET_ZONE, QR_QUIET_ZONE + size));
  expect(modules.flat()).toEqual(Array.from(data, Boolean));
});

it("uses all four compact glyphs, with fixed colors once per line", () => {
  const url = urls[1]!;
  const lines = renderTerminalQR(url, { terminalProgram: "ghostty" }).trimEnd().split("\n");
  expect(new Set(plainLines(url).join(""))).toEqual(new Set(["█", "▀", "▄", " "]));
  for (const line of lines) {
    expect(line).toMatch(/^\x1b\[48;5;16m\x1b\[38;5;231m[█▀▄ ]+\x1b\[0m$/u);
    expect(line.match(/\x1b\[/gu)).toHaveLength(3);
  }
  expect(QR_DARK).toBe("\x1b[48;5;16m");
  expect(QR_LIGHT_FG).toBe("\x1b[38;5;231m");
});

it.each(urls)("has a full four-module quiet zone on every edge: %s", (url) => {
  const grid = terminalQRGrid(url);
  expect(QR_QUIET_ZONE).toBe(4);
  for (let edge = 0; edge < QR_QUIET_ZONE; edge += 1) {
    expect(grid[edge]!.every(dark => !dark)).toBe(true);
    expect(grid.at(-1 - edge)!.every(dark => !dark)).toBe(true);
    expect(grid.every(row => !row[edge] && !row.at(-1 - edge))).toBe(true);
  }
});

it.each(urls)("stays compact, rectangular and free of surrogate-pair glyphs: %s", (url) => {
  const grid = terminalQRGrid(url); const lines = plainLines(url);
  expect(lines).toHaveLength(Math.ceil(grid.length / 2));
  expect(lines.map(line => line.length)).toEqual(Array(lines.length).fill(grid.length));
  expect(lines.every(line => [...line].length === line.length)).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(21);
  expect(renderTerminalQR(url, { terminalProgram: "ghostty" })).toMatch(/\x1b\[0m\n$/u);
});

it.each(urls)("decodes Apple Terminal's font-independent background cells: %s", (url) => {
  expect(decoded(url, "Apple_Terminal")).toBe(url);
  expect(renderedModules(url, "Apple_Terminal")).toEqual(terminalQRGrid(url));
  const plain = stripVTControlCharacters(renderTerminalQR(url, { terminalProgram: "Apple_Terminal" }));
  expect(plain).toMatch(/^[ \n]+$/u);
  const lines = plain.split("\n").slice(0, -1);
  const size = terminalQRGrid(url).length;
  expect(lines).toHaveLength(size);
  expect(lines.map(line => line.length)).toEqual(Array(size).fill(size * 2));
});

it("detects Apple Terminal without changing Ghostty's compact output", () => {
  vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
  expect(stripVTControlCharacters(renderTerminalQR(urls[0]!))).toMatch(/^[ \n]+$/u);
  vi.stubEnv("TERM_PROGRAM", "ghostty");
  expect(renderTerminalQR(urls[0]!)).toMatch(/[▀▄█]/u);
});

it.each(urls)("refuses a QR that would be wrapped or clipped in one-shot output: %s", (url) => {
  vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
  expect(() => renderTerminalQRForOutput(url, { columns: 80, rows: 24 })).toThrow(TerminalQRSizeError);
  expect(() => renderTerminalQRForOutput(url, { columns: 60, rows: 60 })).toThrow(TerminalQRSizeError);
  expect(() => renderTerminalQRForOutput(url, { columns: 100, rows: 50 })).not.toThrow();
  vi.stubEnv("TERM_PROGRAM", "ghostty");
  expect(() => renderTerminalQRForOutput(url, { columns: 80, rows: 24 })).not.toThrow();
});
