import { describe, expect, it } from "vitest";
import { relaySenderIsAllowed, resolveRelayAllowedSenderIds } from "./security.js";

describe("Relay inbound sender gate", () => {
  it("pins the authenticated Relay owner by default", () => {
    expect(
      resolveRelayAllowedSenderIds({ profile: { owner_user_id: "usr_owner" } }),
    ).toEqual(["usr_owner"]);
  });

  it("lets an operator deliberately extend the owner allowlist", () => {
    expect(
      resolveRelayAllowedSenderIds({
        profile: { owner_user_id: "usr_owner" },
        allowFrom: ["usr_teammate", "usr_owner"],
      }),
    ).toEqual(["usr_owner", "usr_teammate"]);
  });

  it("fails closed when neither the API owner nor an explicit allowlist exists", () => {
    expect(resolveRelayAllowedSenderIds({ profile: {} })).toEqual([]);
  });

  it("never converts a wildcard into public agent access", () => {
    expect(resolveRelayAllowedSenderIds({ profile: {}, allowFrom: ["*"] })).toEqual([]);
  });

  it("matches only an exact pinned sender id", () => {
    expect(relaySenderIsAllowed(["usr_owner"], "usr_owner")).toBe(true);
    expect(relaySenderIsAllowed(["usr_owner"], "usr_stranger")).toBe(false);
  });
});
