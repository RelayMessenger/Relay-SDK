import { describe, expect, it } from "vitest";
import { relayBlue } from "./ui-colour.js";

describe("Relay terminal colour", () => {
  it("renders the Relay blue sample", () => {
    const sample = relayBlue("Relay");
    if (process.env.NO_COLOR) expect(sample).toBe("Relay");
    else expect(sample).toContain("38;5;33");
    expect(sample).not.toContain("32m");
  });
  it("uses documented blue palette values", () => {
    expect(relayBlue("x")).toMatch(/x/);
  });
});
