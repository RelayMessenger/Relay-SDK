/**
 * Relay's terminal palette: Relay blue (#0A84FF) for the wordmark, the active
 * option, the spinner and the check; dim for hints and paths; red for errors.
 * No other hue anywhere (owner ruling, _artifacts/cli-connect-design-20260912.md,
 * item 7).
 *
 * Whether colour is painted at all is decided from an environment handed in,
 * never from a library's process-wide guess, so a test can decide it too. The
 * order is picocolors' (src/index.js): NO_COLOR wins, then FORCE_COLOR, then a
 * terminal that is not `dumb`. The depth is supports-color's: FORCE_COLOR=3 or
 * COLORTERM=truecolor|24bit paints 24-bit, anything else the 256-colour cube.
 */
export type ColourDepth = "none" | "256" | "truecolor";

export interface ColourInput {
  env: NodeJS.ProcessEnv;
  /** Whether the stream the text goes to is a terminal. */
  isTTY: boolean;
}

export const colourDepth = ({ env, isTTY }: ColourInput): ColourDepth => {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const forced = env.FORCE_COLOR;
  if (forced === "0" || forced === "false") return "none";
  if (forced === undefined && !(isTTY && env.TERM !== "dumb")) return "none";
  const truecolor = forced === "3" || /truecolor|24bit/iu.test(env.COLORTERM ?? "");
  return truecolor ? "truecolor" : "256";
};

const ESC = "[";
const BLUE_TRUECOLOR = `${ESC}38;2;10;132;255m`;
const BLUE_256 = `${ESC}38;5;33m`;
const FG_RESET = `${ESC}39m`;
const wrap = (open: string, close: string) => (value: string): string => `${open}${value}${close}`;

export interface Palette {
  depth: ColourDepth;
  blue(value: string): string;
  dim(value: string): string;
  red(value: string): string;
  underline(value: string): string;
}

export const palette = (input: ColourInput): Palette => {
  const depth = colourDepth(input);
  if (depth === "none") return { depth, blue: (v) => v, dim: (v) => v, red: (v) => v, underline: (v) => v };
  return {
    depth,
    blue: wrap(depth === "truecolor" ? BLUE_TRUECOLOR : BLUE_256, FG_RESET),
    dim: wrap(`${ESC}2m`, `${ESC}22m`),
    red: wrap(`${ESC}31m`, FG_RESET),
    underline: wrap(`${ESC}4m`, `${ESC}24m`),
  };
};

/** The prompts and the steps go to stderr, so that stream decides for the process. */
export const processPalette = (): Palette => palette({ env: process.env, isTTY: process.stderr.isTTY === true });

const current = processPalette();
export const relayBlue = (value: string): string => current.blue(value);
export const dim = (value: string): string => current.dim(value);
export const error = (value: string): string => current.red(value);
export const handle = (value: string): string => relayBlue(value.startsWith("@") ? value : `@${value}`);
export const link = (value: string): string => current.underline(relayBlue(value));
export const active = (value: string): string => relayBlue(value);
