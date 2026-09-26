import { describe, expect, it } from "vitest";
import { redact, safeErrorMessage, WITHHELD_SECRET, withholdSecretFields } from "./redact.js";

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

describe("secret fields the SDK returns", () => {
  it("withholds signing_secret and other secret-shaped fields, keeping page tokens", () => {
    const created = {
      id: "sub_1",
      signing_secret: "whsec_c2lnbmluZyBzZWNyZXQ=",
      ice_servers: [{ urls: ["turn:turn.example"], username: "u", credential: "turn-pass" }],
      next_page_token: "cursor-2",
      page_token: "cursor-1",
      nested: { access_token: "at", password: "pw" },
    };
    const text = JSON.stringify(created, withholdSecretFields);
    for (const secret of ["whsec_c2lnbmluZyBzZWNyZXQ=", "turn-pass", "\"at\"", "\"pw\""]) {
      expect(text).not.toContain(secret);
    }
    const parsed = JSON.parse(text);
    expect(parsed.signing_secret).toBe(WITHHELD_SECRET);
    expect(parsed.ice_servers[0].credential).toBe(WITHHELD_SECRET);
    expect(parsed.next_page_token).toBe("cursor-2");
    expect(parsed.page_token).toBe("cursor-1");
    expect(parsed.id).toBe("sub_1");
  });
});
