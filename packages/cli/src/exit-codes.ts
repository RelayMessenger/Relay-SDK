/**
 * The exit-code contract, in one place. gh's shape (`gh help exit-codes`,
 * ledger captures/tools/zz-probe2-json-headless.log:40-52): 0 ok, 1 failed,
 * 2 cancelled, 4 authentication. Ours adds 3 for a thing that does not exist,
 * and 2 covers both a usage error and a question with no terminal to ask it
 * on (ledger row P40, decided 2026-09-10). sysexits.h's 64-78 range was
 * declined: gh, stripe and flyctl all use small numbers.
 */
export const EXIT_CODES = {
  /** The command did what was asked. */
  ok: 0,
  /** The command failed for any reason not listed below. */
  failed: 1,
  /** Options the command does not understand, or a question with no terminal. */
  usage: 2,
  /** The thing the command names does not exist. */
  notFound: 3,
  /** A token is needed and none is saved, or Relay did not accept the one it has. */
  signInNeeded: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** The table `relaymessenger help exit-codes` prints, gh's sentences with our cases. */
export const exitCodesHelp = (): string => [
  "relaymessenger exit codes",
  "",
  "relaymessenger follows normal conventions regarding exit codes.",
  "",
  `- If a command completes successfully, the exit code will be ${EXIT_CODES.ok}`,
  `- If a command fails for any reason, the exit code will be ${EXIT_CODES.failed}`,
  `- If a command is given options it does not understand, or needs an answer and has no terminal, the exit code will be ${EXIT_CODES.usage}`,
  `- If the thing a command names does not exist, the exit code will be ${EXIT_CODES.notFound}`,
  `- If a command needs a token and none is saved, or Relay does not accept the one it has, the exit code will be ${EXIT_CODES.signInNeeded}`,
  "",
  "Under --json every failure is one JSON object on stderr: {\"error\", \"code\", \"next_step\"}.",
  "The code is Relay's numeric code as a string for an API fault, and one of",
  "usage, not_a_tty, no_token, not_found, network, refused for a fault in this command.",
  "",
].join("\n");
