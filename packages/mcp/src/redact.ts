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

export const safeErrorMessage = (
  error: unknown,
  secrets: readonly string[],
): string => redact(
  error instanceof Error ? error.message : String(error),
  secrets,
);
