import pc from "picocolors";

const truecolor = process.env.FORCE_COLOR === "3" || /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const relayBlueStyle = truecolor ? pc.rgb(10, 132, 255) : pc.ansi256(33);
/** Relay terminal palette. picocolors honors NO_COLOR, TTY and FORCE_COLOR. */
export const relayBlue = (value: string): string => relayBlueStyle(value);
export const dim = (value: string): string => pc.dim(value);
export const error = (value: string): string => pc.red(value);
export const handle = (value: string): string => relayBlue(value.startsWith("@") ? value : `@${value}`);
export const link = (value: string): string => pc.underline(relayBlue(value));
export const success = (value: string): string => relayBlue(value);
export const active = (value: string): string => relayBlue(value);
