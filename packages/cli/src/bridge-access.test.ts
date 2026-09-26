import { describe, expect, it } from "vitest";
import { PI_READ_ONLY_TOOLS, bridgeLine, piAccess } from "./bridge-access.js";

describe("pi", () => {
  it("runs pi read-only by default", () => {
    expect(piAccess({ fullAccess: false }).piArgs).toEqual(["--tools", "read,grep,find,ls"]);
    expect(piAccess({ fullAccess: false }).piArgs).toBe(PI_READ_ONLY_TOOLS);
  });

  it("gives pi its own default tools back only with --dangerously-skip-permissions", () => {
    expect(piAccess({ fullAccess: true }).piArgs).toEqual([]);
  });
});

describe("the plan's line for a bridge", () => {
  it("says whether it runs commands, in one sentence", () => {
    expect(bridgeLine("Codex", false)).toBe("keep running here, and answer your Relay messages with Codex from this folder; it runs no commands  (--dangerously-skip-permissions turns every permission check off)");
    expect(bridgeLine("Pi", true, ["Relay drives Pi through its native RPC mode"])).toBe("keep running here, and answer your Relay messages with Pi from this folder; it runs every tool with no permission checks  (Relay drives Pi through its native RPC mode; --dangerously-skip-permissions: recommended only for sandboxes with no internet access)");
  });
});
