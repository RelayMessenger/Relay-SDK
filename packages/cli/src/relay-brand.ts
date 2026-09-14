/**
 * The Relay bubble logomark, rasterized from the vector path in
 * Relay-Admin/public/brand/relay-mark.svg onto the Braille dot grid.
 *
 * Method (2026-09-13): the bubble's bounding box (x 210-854, y 185-883 in the
 * 1024-unit SVG) is fitted to 64x68 dots (32 columns x 17 rows) keeping its
 * aspect, centred, and shifted half a dot to the right; the path and the two
 * 48-unit eye arcs are drawn at 16x supersampling and a dot is set when at
 * least half of its area is covered. The earlier Quick Look thumbnail
 * conversion sat 1.4 dots too low, so it clipped the tail flat and left holes
 * in the bottom edge. This is the bubble mark only: no square app tile, no
 * wordmark, no animation, and no ANSI colour.
 */
export const RELAY_BRAILLE = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⣶⣾⣿⣿⣿⣿⣿⣷⣶⣦⣤⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣤⡀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⡄⠀⠀⠀",
  "⠀⠀⣠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀⠀",
  "⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀",
  "⠀⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠛⠛⠿⣿⣿⣿⣿⣿⣿⠿⠛⠛⠛⠿⣿⣿⣿⣿⣿⡇",
  "⢸⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀⣀⣀⣀⠀⠈⠻⣿⣿⠋⠀⠀⣀⣀⣀⠀⠀⠹⣿⣿⣿⣿",
  "⢸⣿⣿⣿⣿⣿⣿⡇⠀⢠⣾⣿⣿⣿⣷⠀⠀⢻⡇⠀⢀⣾⣿⣿⣿⣷⠀⠀⢹⣿⣿⣿",
  "⠸⣿⣿⣿⣿⣿⣿⣧⣤⣼⣿⣿⣿⣿⣿⣦⣤⣾⣧⣤⣼⣿⣿⣿⣿⣿⣦⣤⣼⣿⣿⡏",
  "⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃",
  "⠀⠘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇⠀",
  "⠀⠀⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀",
  "⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠁⠀⠀⠀",
  "⠀⠀⠀⠀⠀⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠋⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠁⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⠿⠛⠛⠛⠻⠿⠟⠛⠛⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠻⠿⠟⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
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
