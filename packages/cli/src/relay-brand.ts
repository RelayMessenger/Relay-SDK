/**
 * The Relay bubble logomark converted from Relay-Admin/public/brand/relay-mark.svg.
 *
 * macOS Quick Look (`qlmanage`) rasterized that standalone SVG, and its pixels
 * were reduced to 2×4 Braille cells. This is the bubble mark only: no square
 * app tile, no wordmark, no animation, and no ANSI colour.
 */
export const RELAY_BRAILLE = [
  "⠀⠀⠀⠀⠀⠀⠀⢀⣠⣴⣶⣾⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⢀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄⠀⠀⠀",
  "⠀⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⡀⠀",
  "⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀",
  "⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠿⠿⣿⣿⣿⣿⣿⣿⣿⡿⠿⠿⠿⢿⣿⣿⣿⣿⣿⣧",
  "⣿⣿⣿⣿⣿⣿⣿⡿⠋⠀⢀⣀⣀⡀⠀⠙⢿⣿⣿⠟⠁⠀⣀⣀⣀⠀⠈⢻⣿⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⣿⠃⠀⣰⣿⣿⣿⣿⣦⠀⠈⣿⡏⠀⢠⣿⣿⣿⣿⣷⡀⠀⢿⣿⣿⣿",
  "⣿⣿⣿⣿⣿⣿⣿⣤⣤⣿⣿⣿⣿⣿⣿⣤⣤⣿⣧⣠⣼⣿⣿⣿⣿⣿⣧⣠⣾⣿⣿⣿",
  "⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇",
  "⠈⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀",
  "⠀⠈⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀",
  "⠀⠀⠀⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀⠀",
  "⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁⠀⠀⠀",
  "⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋⠁⠀⠀⠀",
  "⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⠿⠿⣿⣿⣿⣿⣿⠿⠿⠛⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⢸⣿⣿⣿⠿⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
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
