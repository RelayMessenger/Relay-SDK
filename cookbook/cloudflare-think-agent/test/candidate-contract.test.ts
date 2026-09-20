import { expect, it } from "vitest";
import { thinkCandidateMode, verifyThinkCandidates } from "./candidate-contract.js";

it("never infers candidate mode from installed prerelease versions or an overlay receipt", () => {
  expect(thinkCandidateMode({})).toBe(false);
  expect(thinkCandidateMode({ RELAY_THINK_CANDIDATE_LOCKFILE: "/tmp/receipt.json" })).toBe(false);
});

it.each([
  { RELAY_SDK_CANDIDATE_TARBALL: "/tmp/sdk.tgz" },
  { RELAY_CHAT_SDK_CANDIDATE_TARBALL: "/tmp/adapter.tgz" },
  { RELAY_SDK_CANDIDATE_TARBALL: "", RELAY_CHAT_SDK_CANDIDATE_TARBALL: "/tmp/adapter.tgz" },
])("fails closed instead of falling back to registry proof for partial candidate env: %j", async (env) => {
  expect(thinkCandidateMode(env)).toBe(true);
  await expect(verifyThinkCandidates(process.cwd(), env)).rejects.toThrow("requires both");
});

it("requires absolute candidate helper and install receipt paths", async () => {
  await expect(verifyThinkCandidates(process.cwd(), {
    RELAY_SDK_CANDIDATE_TARBALL: "/tmp/sdk.tgz",
    RELAY_CHAT_SDK_CANDIDATE_TARBALL: "/tmp/adapter.tgz",
    RELAY_THINK_CANDIDATE_HELPER: "relative-helper.mjs",
  })).rejects.toThrow("must be absolute");
});
