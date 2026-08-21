import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RelayClient } from "./api.js";
import { decisionJson, notifyCommand } from "./codex.js";
import {
  CodexNotifyPolicyStore,
  ConfigStore,
  runtimeHomeForConfig,
  StateStore,
} from "./store.js";

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

test("Codex notify suppresses other repositories and sends only opted-in project content", async () => {
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-codex-notify-"));
  const allowed = join(home, "allowed-project");
  const nested = join(allowed, "packages", "app");
  const other = join(home, "private-other-project");
  mkdirSync(nested, { recursive: true });
  mkdirSync(other, { recursive: true });
  const config = new ConfigStore(home);
  const loaded = {
    api_origin: "https://api.relayapp.im",
    agent_token: "token",
    owner_user_id: "usr_owner",
    agent: { id: "agt_notify" },
  };
  config.save(loaded);
  const state = new StateStore(runtimeHomeForConfig(loaded, home));
  state.current.owner_conversation_id = "cnv_owner";
  state.persist();
  const policy = new CodexNotifyPolicyStore(home);
  policy.allowProject(allowed);
  const sent: Array<{ body: any; key: string }> = [];
  const client = {
    async postMessage(body: any, key: string) {
      sent.push({ body, key });
      return { messages: [{ id: "m1", sequence: 1 }] };
    },
  } as unknown as RelayClient;
  const deps = { config, policy, client };

  await notifyCommand([
    JSON.stringify({
      type: "agent-turn-complete",
      cwd: other,
      "last-assistant-message": "secret from another repo",
    }),
  ], () => {}, deps);
  assert.equal(sent.length, 0, "a globally configured Codex hook must not cross project roots");

  await notifyCommand([
    JSON.stringify({
      type: "agent-turn-complete",
      cwd: nested,
      "last-assistant-message": "safe final answer",
      "input-messages": ["private user prompt is not part of the fallback"],
      "turn-id": "turn-1",
    }),
  ], () => {}, deps);
  assert.equal(sent.length, 1);
  const text = sent[0]!.body.parts[0].text as string;
  assert.match(text, /Codex \(allowed-project\): safe final answer/);
  assert.doesNotMatch(text, /private user prompt/);
  assert.doesNotMatch(text, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
