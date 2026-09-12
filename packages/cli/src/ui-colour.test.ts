import { describe, expect, it } from "vitest";
import { relayBlueForEnv } from "./ui-colour.js";
describe("Relay terminal colour", () => {
  it("uses truecolor", () => expect(relayBlueForEnv("Relay", { COLORTERM: "truecolor" })).toContain("38;2;10;132;255"));
  it("uses 256 colour fallback", () => expect(relayBlueForEnv("Relay", { TERM: "xterm-256color" })).toContain("38;5;33"));
  it("honors NO_COLOR", () => expect(relayBlueForEnv("Relay", { NO_COLOR: "1" })).toBe("Relay"));
  it("has no green SGR", () => expect(relayBlueForEnv("Relay", { COLORTERM: "truecolor" })).not.toContain("32m"));
});
