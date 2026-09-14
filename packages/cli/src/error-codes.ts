import { EXIT_CODES, type ExitCode } from "./exit-codes.js";

/**
 * Every failure this command reports carries a machine-readable code and one
 * next step: Stripe's headless envelope (`next_step`, ledger README P13),
 * netlify's `{"error": {"code", "fix"}}` (the one third-party tool measured
 * with a code), and MCP's two error classes (a malformed request versus a
 * request that ran and failed). An API fault keeps Relay's own numeric code as
 * a string; a fault inside this command takes one of the names below, and
 * nowhere else defines one (decided 2026-09-10, fix rows 4 and 5).
 */
export const CLI_ERROR_CODES = ["usage", "not_a_tty", "no_runtime", "no_token", "not_found", "network", "refused"] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

/** One sentence per code, and no two codes share one (the test proves it). */
export const NEXT_STEP: Record<CliErrorCode, string> = {
  usage: "Run  npx relaymessenger help <command>  to see the options it takes.",
  no_runtime: "Run  npx relaymessenger connect <agent>  to choose a runtime.",
  not_a_tty: "Pass the flags the error names; run  npx relaymessenger help <command>  to see them all.",
  no_token: "Run  npx relaymessenger connect  to create an agent, or pipe a token into  npx relaymessenger auth login --with-token.",
  not_found: "Run  npx relaymessenger agents list  to see what is saved on this computer.",
  network: "Check this computer's network connection, then run the command again.",
  refused: "Run  npx relaymessenger doctor  to check this computer.",
};

export const EXIT_FOR: Record<CliErrorCode, ExitCode> = {
  usage: EXIT_CODES.usage,
  no_runtime: EXIT_CODES.notFound,
  not_a_tty: EXIT_CODES.usage,
  no_token: EXIT_CODES.signInNeeded,
  not_found: EXIT_CODES.notFound,
  network: EXIT_CODES.failed,
  refused: EXIT_CODES.failed,
};

/** A failure inside this command, named. Anything thrown without a name is `refused`. */
export class CliError extends Error {
  constructor(message: string, readonly code: CliErrorCode) { super(message); }
}
