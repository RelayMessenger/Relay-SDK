import { describe, expect, it } from "vitest";
import { redact, safeErrorMessage } from "./redact.js";

describe("MCP secret redaction", () => {
  it("redacts raw and URL-encoded token copies", () => {
    const token = "rly_secret/value+123";
    const value = redact(
      `${token} ${encodeURIComponent(token)}`,
      [token],
    );
    expect(value).not.toContain(token);
    expect(value).not.toContain(encodeURIComponent(token));
    expect(value).toContain("[REDACTED]");
  });

  it("returns only a sanitized error message", () => {
    expect(
      safeErrorMessage(new Error("failed rly_secret_123"), ["rly_secret_123"]),
    ).toBe("failed [REDACTED]");
  });
});
