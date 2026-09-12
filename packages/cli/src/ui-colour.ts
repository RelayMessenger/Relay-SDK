import pc from "picocolors";

const truecolor = process.env.FORCE_COLOR === "3" || /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const BLUE = truecolor ? `\x1b[38;2;10;132;255m` : `\x1b[38;5;33m`; const RESET = `\x1b[39m`;
/** Relay terminal palette. picocolors honors NO_COLOR, TTY and FORCE_COLOR. */
export const relayBlue = (value: string): string => pc.isColorSupported ? `${BLUE}${value}${RESET}` : value;
export const dim = (value: string): string => pc.dim(value);
export const error = (value: string): string => pc.red(value);
export const handle = (value: string): string => relayBlue(value.startsWith("@") ? value : `@${value}`);
export const link = (value: string): string => pc.underline(relayBlue(value));
export const success = (value: string): string => relayBlue(value);
export const active = (value: string): string => relayBlue(value);
