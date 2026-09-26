const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const redact = (
  value: string,
  secrets: readonly string[],
): string => {
  let output = value;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    output = output.replace(
      new RegExp(escapeRegExp(secret), "g"),
      "[REDACTED]",
    );
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        output = output.replace(
          new RegExp(escapeRegExp(encoded), "g"),
          "[REDACTED]",
        );
      }
    } catch {
      // Raw replacement above remains effective.
    }
  }
  return output;
};

/**
 * What a model sees in place of a secret the SDK returned. The secret-shaped
 * fields in the Relay contract are `signing_secret` (a new webhook
 * subscription's signing key) and a TURN server's `credential` (Call room ICE
 * servers); a field named like any other secret, password or token is held
 * back too. Page tokens are cursors, not credentials, and pass through.
 */
export const WITHHELD_SECRET =
  "[withheld: this is a secret; Relay returned it, but it is never shown to the model]";

export const isSecretKey = (key: string): boolean =>
  /secret|credential|password|api_?key/iu.test(key)
  || (/(?:^|_)token$/iu.test(key) && !/page_token$/iu.test(key));

/** A JSON.stringify replacer that withholds every secret-shaped field. */
export const withholdSecretFields = (key: string, value: unknown): unknown =>
  key !== "" && isSecretKey(key) && value !== null && value !== undefined
    && typeof value !== "object" ? WITHHELD_SECRET : value;

export const safeErrorMessage = (
  error: unknown,
  secrets: readonly string[],
): string => redact(
  error instanceof Error ? error.message : String(error),
  secrets,
);
