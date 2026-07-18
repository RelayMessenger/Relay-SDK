import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RECENT_EVENT_IDS_LIMIT, StateStore, loadConfig, parseEnvFile } from "../src/config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "relay-channel-config-"));
}

describe("config loading", () => {
  it("an empty value in .env does not mask a process-env token", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "RELAY_AGENT_TOKEN=\nRELAY_BASE_URL=\n");
    const config = loadConfig({
      RELAY_CHANNEL_DIR: dir,
      RELAY_AGENT_TOKEN: "rly_from_process_env",
    } as NodeJS.ProcessEnv);
    assert.equal(config.agentToken, "rly_from_process_env");
    assert.equal(config.baseUrl, "https://api.relayapp.im");
  });

  it(".env values win over process env when non-empty", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "RELAY_AGENT_TOKEN=rly_from_file\n");
    const config = loadConfig({
      RELAY_CHANNEL_DIR: dir,
      RELAY_AGENT_TOKEN: "rly_from_process_env",
    } as NodeJS.ProcessEnv);
    assert.equal(config.agentToken, "rly_from_file");
  });

  it("tightens .env to mode 600", () => {
    const dir = tempDir();
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "RELAY_AGENT_TOKEN=rly_x\n", { mode: 0o644 });
    loadConfig({ RELAY_CHANNEL_DIR: dir } as NodeJS.ProcessEnv);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
  });

  it("TOFU is off unless RELAY_ALLOW_TOFU=1", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "RELAY_AGENT_TOKEN=rly_x\n");
    assert.equal(loadConfig({ RELAY_CHANNEL_DIR: dir } as NodeJS.ProcessEnv).allowTofu, false);
    writeFileSync(join(dir, ".env"), "RELAY_AGENT_TOKEN=rly_x\nRELAY_ALLOW_TOFU=1\n");
    assert.equal(loadConfig({ RELAY_CHANNEL_DIR: dir } as NodeJS.ProcessEnv).allowTofu, true);
  });

  it("parses quoted values and ignores comments", () => {
    const values = parseEnvFile('# comment\nexport A="one two"\nB=\'three\'\nbad line\n');
    assert.deepEqual(values, { A: "one two", B: "three" });
  });
});

describe("state store dedupe", () => {
  it("remembers handled event ids across reloads and bounds the list", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    for (let i = 0; i < RECENT_EVENT_IDS_LIMIT + 10; i++) {
      store.markEventSeen(`evt_${i}`);
    }
    assert.equal(store.hasSeenEvent("evt_0"), false); // evicted
    assert.equal(store.hasSeenEvent(`evt_${RECENT_EVENT_IDS_LIMIT + 9}`), true);
    assert.equal(store.get().recent_event_ids?.length, RECENT_EVENT_IDS_LIMIT);

    // A fresh store (e.g. after restart with cursor reset) still dedupes.
    const reloaded = new StateStore(dir);
    assert.equal(reloaded.hasSeenEvent(`evt_${RECENT_EVENT_IDS_LIMIT + 9}`), true);
    assert.equal(reloaded.hasSeenEvent("evt_0"), false);
  });

  it("markEventSeen can persist extra state in the same write", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    store.markEventSeen("evt_a", { last_conversation_id: "cnv_1" });
    const reloaded = new StateStore(dir);
    assert.equal(reloaded.get().last_conversation_id, "cnv_1");
    assert.equal(reloaded.hasSeenEvent("evt_a"), true);
  });
});
