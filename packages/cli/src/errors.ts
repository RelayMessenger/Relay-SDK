import { CommanderError, InvalidArgumentError } from "commander";
import { RelayAPIError } from "@relaymessenger/sdk";
import { HeadlessPrompt } from "./interactive.js";
import { EXIT_CODES, type ExitCode } from "./exit-codes.js";
import { CliError, EXIT_FOR, NEXT_STEP, type CliErrorCode } from "./error-codes.js";
import { errorText } from "./output.js";

/** The envelope `--json` prints on stderr, plus the exit code it earns. */
export interface Failure {
  error: string;
  code: string;
  next_step: string;
  exit: ExitCode;
}

/** Relay's documentation for an API code, when the API named no page itself. */
const API_NEXT_STEP = "Read https://docs.relayapp.im/llms.txt for what the code means.";

/** gh's 4 for "requires authentication"; 3 for a thing that is not there. */
const exitForStatus = (status: number): ExitCode =>
  status === 401 || status === 403 ? EXIT_CODES.signInNeeded
    : status === 404 ? EXIT_CODES.notFound
    : EXIT_CODES.failed;

const named = (error: unknown, code: CliErrorCode, secrets: readonly string[]): Failure =>
  ({ error: errorText(error, secrets), code, next_step: NEXT_STEP[code], exit: EXIT_FOR[code] });

/** What went wrong, as the caller reads it: the sentence, the code, the next step, the exit code. */
export const describeFailure = (error: unknown, secrets: readonly string[] = []): Failure => {
  if (error instanceof CliError) return named(error, error.code, secrets);
  // A question with no terminal names the flags that would have answered it
  // inside the sentence, so the one next step per code still holds.
  if (error instanceof HeadlessPrompt) {
    const hint = error.flags.length ? `Pass one of: ${error.flags.join(";  ")}.` : error.nextStep;
    return named(`${error.message} ${hint}`.trim(), "not_a_tty", secrets);
  }
  // Commander's sentence, without its "error: " prefix: the envelope is the error.
  if (error instanceof InvalidArgumentError || error instanceof CommanderError) {
    return named(error.message.replace(/^error: /u, "").replace(/rly_[A-Za-z0-9_-]+/gu, "[REDACTED]").trim(), "usage", secrets);
  }
  if (error instanceof RelayAPIError) {
    if (error.status === undefined) return named(error, "network", secrets);
    return {
      error: errorText(error, secrets),
      code: String(error.code ?? error.status),
      next_step: `${API_NEXT_STEP} Code: ${error.code ?? error.status}.`,
      exit: exitForStatus(error.status),
    };
  }
  if (error instanceof TypeError && /fetch failed/iu.test(error.message)) return named(error, "network", secrets);
  return named(error, "refused", secrets);
};
