const REDACTED = "[REDACTED]";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const redactText = (
  value: string,
  secrets: readonly string[],
): string => {
  let output = value;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        output = output.replace(
          new RegExp(escapeRegExp(encoded), "g"),
          REDACTED,
        );
      }
    } catch {
      // Invalid URL encoding input is still redacted in its raw form.
    }
  }
  return output;
};

export const errorText = (
  error: unknown,
  secrets: readonly string[] = [],
): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw, secrets);
};

export const jsonText = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
