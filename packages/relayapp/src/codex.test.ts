import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionJson } from "./codex.js";

test("regression: hook decisions carry the exact Codex PermissionRequest envelope", () => {
  // The Codex hooks contract requires hookSpecificOutput.hookEventName —
  // without it the decision is invalid and the phone tap is dropped.
  assert.deepEqual(decisionJson(true), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
  const deny = decisionJson(false) as {
    hookSpecificOutput: {
      hookEventName: string;
      decision: { behavior: string; message?: string };
    };
  };
  assert.equal(deny.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
  assert.equal(typeof deny.hookSpecificOutput.decision.message, "string");
});
