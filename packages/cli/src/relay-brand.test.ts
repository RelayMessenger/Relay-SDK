import { expect, it } from "vitest";
import { RELAY_BRAILLE, relayHelpHeading, writeRelayHelpHeading } from "./relay-brand.js";

it("keeps only the converted bubble logomark with terminal-safe proportions", () => {
  expect(RELAY_BRAILLE).toHaveLength(16);
  const widths = RELAY_BRAILLE.map((line) => [...line].length);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(24);
  expect(Math.max(...widths)).toBeLessThanOrEqual(32);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
  expect(relayHelpHeading()).toContain(RELAY_BRAILLE[0]);
  expect(relayHelpHeading()).not.toContain("Relay");
  expect(relayHelpHeading()).not.toContain("\u001b[");
});

it("uses the same static mark off and on a TTY", async () => {
  const output: string[] = [];
  await writeRelayHelpHeading((value) => output.push(value), false);
  await writeRelayHelpHeading((value) => output.push(value), true);
  expect(output).toEqual([relayHelpHeading(), relayHelpHeading()]);
});
