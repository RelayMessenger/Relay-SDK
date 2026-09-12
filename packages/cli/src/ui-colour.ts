import pc from "picocolors";

/**
 * The three ways a value is marked inside a sentence, and the only three.
 *
 * Clack draws its own frame with `node:util`'s `styleText` and leaves the
 * message text alone, so the values inside our sentences are ours to mark. Its
 * own example marks them with picocolors (clack examples/basic/index.ts:3, and
 * `examples/basic/package.json` lists picocolors as the dependency for it).
 *
 * picocolors decides once, when it is imported, from `NO_COLOR`, `FORCE_COLOR`
 * and whether stdout is a terminal. A pipe, a redirect and a `NO_COLOR` terminal
 * all get the plain sentence back, so nothing here has to check for itself.
 */

/** A Relay handle, always written with its @. */
export const handle = (value: string): string =>
  pc.cyan(pc.bold(value.startsWith("@") ? value : `@${value}`));

/** A path, a command, or any value a person reads only when something is wrong. */
export const dim = (value: string): string => pc.dim(value);

/** An address a person can open. */
export const link = (value: string): string => pc.cyan(pc.underline(value));
