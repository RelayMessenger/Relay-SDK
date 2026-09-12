import { describe, expect, it } from "vitest";
import { relaySetupContract } from "../src/channel.js";

const cfg = { channels: {} } as any;

describe("Relay OpenClaw setup contract", () => {
  it("rejects a missing token with the plugin error text", () => {
    const result = relaySetupContract.parseInput({});
    expect(result).toEqual({ ok: false, error: "relay: account \"default\" has no Relay Agent Token" });
  });

  it("pins the applied account config", () => {
    const result = relaySetupContract.applyAccountConfig({ cfg, accountId: "default", input: { token: "t", baseUrl: "u" } });
    expect(result).toEqual({ channels: { relay: { token: "t", baseUrl: "u" } } });
  });

  it("exposes exactly one required wizard question", () => {
    const fields = relaySetupContract.metadata.fields;
    expect(fields).toHaveLength(2);
    expect(fields.filter((field: any) => field.key === "token" && field.kind === "string")).toHaveLength(1);
    expect(fields.filter((field: any) => field.key === "baseUrl")).toHaveLength(1);
  });
});
