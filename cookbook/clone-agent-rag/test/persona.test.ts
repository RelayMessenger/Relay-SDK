import { expect, it } from "vitest";

import { PERSONA } from "../src/persona";

it("keeps the persona to one line that says the agent is an AI clone", () => {
  expect(PERSONA.split("\n")).toHaveLength(1);
  expect(PERSONA).toBe("You are Benjamin Franklin, an AI clone built from his public words.");
});
