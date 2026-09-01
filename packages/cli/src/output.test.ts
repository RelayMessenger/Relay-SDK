import { describe, expect, it } from "vitest";
import { errorText, redactText } from "./output.js";

describe("secret redaction", () => {
  it("redacts raw and URL-encoded token copies", () => {
    const token = "rly_test/secret+value";
    const output = redactText(
      `authorization failed for ${token} (${encodeURIComponent(token)})`,
      [token],
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain(encodeURIComponent(token));
    expect(output).toContain("[REDACTED]");
  });

  it("redacts error messages without serializing error bodies", () => {
    expect(errorText(new Error("bad rly_secret_value"), ["rly_secret_value"]))
      .toBe("bad [REDACTED]");
  });
});
