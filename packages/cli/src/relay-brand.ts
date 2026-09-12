/**
 * The Relay bubble logomark converted from Relay-Docs/dark.svg.
 *
 * macOS Quick Look (`qlmanage`) rasterized the SVG, the square bubble icon
 * was cropped, and its pixels were reduced to 2×4 Braille cells.
 * This is the mark only: no wordmark and no ANSI colour.
 */
export const RELAY_BRAILLE = [
  "⠀⠀⢀⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⡀⠀⠀",
  "⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀",
  "⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄",
  "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⡿⠿⠛⠛⠛⠛⠛⠛⠛⠛⠻⠿⣿⣿⣿⣿⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⣿⣿⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⣠⣶⣿⣶⣄⠀⢀⣴⣾⣿⣿⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⢸⣿⠋⠀⠙⣿⡆⣾⡿⠁⠀⠈⢿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⡀⠀⠀⠀⠈⠉⠀⠀⠀⠉⠀⠉⠀⠀⠀⠈⠉⣿⣿",
  "⣿⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿",
  "⣿⣿⣿⣿⣿⣿⣿⣧⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣿⣿",
  "⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣤⣀⠀⠀⠀⠀⠀⠀⣀⣤⣿⣿⣿⣿⣿",
  "⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇",
  "⠀⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠀",
  "⠀⠀⠈⠛⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠁",
] as const;

export const relayHelpHeading = (): string =>
  `${RELAY_BRAILLE.map((line) => `  ${line}`).join("\n")}\n`;

/** Write the same mark in every terminal. It never adds colour or animation. */
export const writeRelayHelpHeading = async (
  write: (value: string) => void,
  _isTTY: boolean,
): Promise<void> => {
  write(relayHelpHeading());
};
