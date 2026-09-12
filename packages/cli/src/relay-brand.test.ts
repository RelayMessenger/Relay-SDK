import { expect, it } from "vitest";
import { palette } from "./ui-colour.js";
import { RELAY_BRAILLE, relayHelpHeading, writeRelayHelpHeading } from "./relay-brand.js";

const plain = palette({ env: { NO_COLOR: "1" }, isTTY: false });

it("keeps the Relay mark as an 11-row Braille heading with a blue wordmark", () => {
  expect(RELAY_BRAILLE).toHaveLength(11);
  expect(relayHelpHeading(plain)).toContain("Relay");
  expect(relayHelpHeading(plain)).toContain(RELAY_BRAILLE[0]);
});

it("uses one static heading off a TTY", async () => {
  const output: string[] = [];
  await writeRelayHelpHeading((value) => output.push(value), plain, false);
  expect(output).toEqual([relayHelpHeading(plain)]);
});

it("builds the heading only on a TTY and leaves the final wordmark visible", async () => {
  const output: string[] = [];
  await writeRelayHelpHeading((value) => output.push(value), plain, true);
  const rendered = output.join("");
  expect(rendered).toContain("\u001b[?25l");
  expect(rendered).toContain("\u001b[?25h");
  expect(rendered).toContain("Relay");
  expect(rendered).toContain("\u001b[13A\u001b[0J");
});
