import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ADAPTER_PACKAGES,
  ADAPTER_VERSIONS,
  adapterEntrypoint,
  engineEnv,
  engineProcessSpec,
  mergeToolCall,
  permissionDetail,
  permissionInputComplete,
} from "./acp.js";
import { ENGINE_NAMES, EXTERNAL_ENGINE_SPECS } from "./catalog.js";

test("ACP adapters are exact runtime dependencies with installed entrypoints", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const engine of ["claude", "codex"] as const) {
    assert.equal(
      pkg.dependencies[ADAPTER_PACKAGES[engine]],
      ADAPTER_VERSIONS[engine],
      `${engine} adapter dependency must be exact`,
    );
    assert.equal(existsSync(adapterEntrypoint(engine)), true);
  }
});

test("every named external engine uses its documented shell-free ACP argv", () => {
  for (const engine of ENGINE_NAMES) {
    const processSpec = engineProcessSpec(engine);
    assert.equal(processSpec.command.length > 0, true, `${engine} command`);
    assert.equal(processSpec.args.length > 0, true, `${engine} args`);
    if (engine === "claude" || engine === "codex") {
      assert.equal(processSpec.command, process.execPath);
    } else {
      assert.deepEqual(processSpec, {
        command: EXTERNAL_ENGINE_SPECS[engine].command,
        args: EXTERNAL_ENGINE_SPECS[engine].args,
        display: `${EXTERNAL_ENGINE_SPECS[engine].displayName} (` +
          `${EXTERNAL_ENGINE_SPECS[engine].command} ${EXTERNAL_ENGINE_SPECS[engine].args.join(" ")})`,
      });
    }
  }
});

test("ACP subprocess environment excludes unrelated parent secrets", () => {
  const filtered = engineEnv({
    PATH: "/bin",
    HOME: "/home/test",
    OPENAI_API_KEY: "provider-key",
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    GITHUB_TOKEN: "must-not-cross",
    RELAY_AGENT_TOKEN: "must-not-cross",
    NPM_TOKEN: "must-not-cross",
    NODE_OPTIONS: "--require /tmp/inject.js",
    RELAYAPP_ENGINE_ENV: "CUSTOM_ONE,CUSTOM_PREFIX_*",
    CUSTOM_ONE: "one",
    CUSTOM_PREFIX_TWO: "two",
  });
  assert.deepEqual(filtered, {
    PATH: "/bin",
    HOME: "/home/test",
    OPENAI_API_KEY: "provider-key",
    CUSTOM_ONE: "one",
    CUSTOM_PREFIX_TWO: "two",
  });
});

test("ACP approval detail includes raw input, affected paths and content", () => {
  const detail = permissionDetail({
    toolCallId: "tool_1",
    title: "Shell",
    kind: "execute",
    status: "pending",
    rawInput: { command: "deploy --production" },
    locations: [{ path: "/repo/infra.ts", line: 12 }],
    content: [
      { type: "content", content: { type: "text", text: "full command context" } },
      { type: "diff", path: "/repo/infra.ts", oldText: "a", newText: "b" },
    ],
  } as any);
  assert.match(detail!, /deploy --production/);
  assert.match(detail!, /\/repo\/infra\.ts/);
  assert.match(detail!, /full command context/);
  assert.match(detail!, /--- before\na\n\+\+\+ after\nb/);
  assert.equal(permissionInputComplete({
    toolCallId: "tool_1",
    rawInput: { command: "deploy --production" },
  }), true);
});

test("ACP approval detail accepts a complete cached diff without raw input", () => {
  const first = mergeToolCall(undefined, {
    toolCallId: "tool_2",
    title: "Update app.ts",
    content: [
      { type: "diff", path: "/repo/app.ts", oldText: "old", newText: "new" },
    ],
  });
  const permission = mergeToolCall(first, {
    toolCallId: "tool_2",
    status: "pending",
  });
  const detail = permissionDetail(permission);
  assert.match(detail!, /diff \/repo\/app\.ts/);
  assert.match(detail!, /--- before\nold\n\+\+\+ after\nnew/);
  assert.equal(permissionInputComplete(permission), true);
});

test("ACP approval detail fails closed when exact input is unavailable", () => {
  const detail = permissionDetail({
    toolCallId: "tool_3",
    title: "Shell",
    kind: "execute",
    status: "pending",
    locations: [{ path: "/repo/infra.ts", line: 12 }],
    content: [{ type: "content", content: { type: "text", text: "generic summary" } }],
  } as any);
  assert.equal(detail, "paths: /repo/infra.ts\ngeneric summary");
  assert.equal(permissionInputComplete({
    toolCallId: "tool_3",
    locations: [{ path: "/repo/infra.ts", line: 12 }],
    content: [{ type: "content", content: { type: "text", text: "generic summary" } }],
  }), false);
  assert.equal(permissionInputComplete({ toolCallId: "tool_4", rawInput: null }), false);
});
