import { describe, expect, it } from "vitest";
import { relayChannelPlugin, relaySetupContract } from "../src/channel.js";

const cfg = { channels: {} } as any;

describe("Relay OpenClaw setup contract", () => {
  it("rejects a missing token with the plugin error text", () => {
    const result = relaySetupContract.parseInput({});
    expect(result).toEqual({ ok: false, error: "relay: account \"default\" has no Relay Agent Token" });
  });

  it("matches the legacy account config for non-interactive flags", () => {
    const input = { token: "t", baseUrl: "u" };
    const contractCfg = relaySetupContract.applyAccountConfig({ cfg, accountId: "default", input });
    const legacyCfg = relayChannelPlugin.setup!.applyAccountConfig({ cfg, accountId: "default", input });
    expect(contractCfg).toEqual(legacyCfg);
  });

  it("exposes exactly one required wizard question", () => {
    const fields = relaySetupContract.metadata.fields;
    expect(fields).toHaveLength(2);
    expect(fields.filter((field: any) => field.key === "token" && field.kind === "string")).toHaveLength(1);
    expect(fields.filter((field: any) => field.key === "baseUrl")).toHaveLength(1);
  });
});
