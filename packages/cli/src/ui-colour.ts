import pc from "picocolors";

/** Relay terminal palette. picocolors honors NO_COLOR, TTY and FORCE_COLOR. */
export const relayBlue = (value: string): string => pc.isColorSupported ? pc.rgb(10, 132, 255)(value) : value;
export const dim = (value: string): string => pc.dim(value);
export const error = (value: string): string => pc.red(value);
export const handle = (value: string): string => relayBlue(value.startsWith("@") ? value : `@${value}`);
export const link = (value: string): string => pc.underline(relayBlue(value));
export const success = (value: string): string => relayBlue(value);
export const active = (value: string): string => relayBlue(value);
