import { describe, expect, it } from "vitest";
import { startHermesRelayChannel } from "./index.js";

describe("startHermesRelayChannel", () => {
  it("exports a starter", () => {
    expect(typeof startHermesRelayChannel).toBe("function");
  });
});
