import type { Palette } from "./ui-colour.js";

/** The Relay mark reduced from Relay-Docs/logo/dark.png to terminal Braille. */
export const RELAY_BRAILLE = [
  "⠀⠀⠀⠀⢀⣠⣴⣶⣿⣿⣿⣿⣿⣶⣦⣤⣀⠀⠀⠀⠀⠀",
  "⠀⠀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⡀⠀⠀",
  "⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀",
  "⣸⣿⣿⣿⣿⣿⡿⠿⠿⠿⣿⣿⣿⣿⣿⡿⠿⠿⢿⣿⣿⣿⣧",
  "⣿⣿⣿⣿⣿⣿⡏⠀⣠⣤⡄⠈⣿⣿⠏⢀⣤⣤⡀⠙⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⣇⣸⣿⣿⣿⣄⣼⣿⣄⣼⣿⣿⣧⣠⣿⣿⡿",
  "⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃",
  "⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀",
  "⠀⠀⠈⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁⠀⠀",
  "⠀⠀⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋⠁⠀⠀⠀⠀",
  "⠀⠀⢸⣿⣿⠿⠛⠉⠉⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀",
] as const;

const wordmark = (palette: Palette, value: string): string =>
  palette.blue(value);

export const relayHelpHeading = (palette: Palette): string =>
  `${RELAY_BRAILLE.map((line) => `  ${palette.blue(line)}`).join("\n")}\n\n  ${wordmark(palette, "Relay")}\n`;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Draw the wordmark in a terminal only. Piped output gets one static heading,
 * while TTY output gets a short build-in and ends on the same static heading.
 */
export const writeRelayHelpHeading = async (
  write: (value: string) => void,
  palette: Palette,
  isTTY: boolean,
): Promise<void> => {
  if (!isTTY) {
    write(relayHelpHeading(palette));
    return;
  }
  const frames = ["", "R", "Re", "Rel", "Rela", "Relay"];
  const staticLines = RELAY_BRAILLE.length + 2;
  write("\u001b[?25l");
  for (const [index, value] of frames.entries()) {
    if (index > 0) write(`\u001b[${staticLines}A\u001b[0J`);
    write(`${RELAY_BRAILLE.map((line) => `  ${palette.blue(line)}`).join("\n")}\n\n  ${wordmark(palette, value)}\n`);
    if (index < frames.length - 1) await sleep(42);
  }
  write("\u001b[?25h");
};
