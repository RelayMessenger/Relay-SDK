import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ConsumerLock,
  CorruptLedgerError,
  RECENT_EVENT_IDS_LIMIT,
  StateStore,
  loadConfig,
  parseEnvFile,
  sessionStateDir,
  type StateScope,
} from "../src/config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "relay-channel-config-"));
}

const SCOPE: StateScope = {
  baseUrl: "https://api.relayapp.im",
  agentId: "agt_test",
  sessionId: "project:/tmp/repo-one",
};

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

  it("uses a stable explicit session id and canonicalizes the origin", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".env"),
      "RELAY_BASE_URL=https://API.RELAYAPP.IM:443/\nRELAY_CHANNEL_SESSION_ID=repo-one\n",
    );
    const config = loadConfig({ RELAY_CHANNEL_DIR: dir } as NodeJS.ProcessEnv);
    assert.equal(config.baseUrl, "https://api.relayapp.im");
    assert.equal(config.sessionId, "repo-one");
  });

  it("rejects credential destinations that are insecure or contain a path", () => {
    for (const baseUrl of ["http://relay.example", "https://relay.example/v1", "file:///tmp/x"]) {
      const dir = tempDir();
      writeFileSync(join(dir, ".env"), `RELAY_BASE_URL=${baseUrl}\n`);
      assert.throws(() => loadConfig({ RELAY_CHANNEL_DIR: dir } as NodeJS.ProcessEnv));
    }
  });

  it("parses quoted values and ignores comments", () => {
    const values = parseEnvFile('# comment\nexport A="one two"\nB=\'three\'\nbad line\n');
    assert.deepEqual(values, { A: "one two", B: "three" });
  });
});

describe("namespaced durable state", () => {
  it("isolates state by origin, agent, and session", () => {
    const dir = tempDir();
    const paths = [
      sessionStateDir(dir, SCOPE),
      sessionStateDir(dir, { ...SCOPE, baseUrl: "https://api.secondary.example" }),
      sessionStateDir(dir, { ...SCOPE, agentId: "agt_other" }),
      sessionStateDir(dir, { ...SCOPE, sessionId: "project:/tmp/repo-two" }),
    ];
    assert.equal(new Set(paths).size, 4);
  });

  it("shares the consumer cursor/dedupe across sequential sessions without sharing approvals", () => {
    const dir = tempDir();
    const sessionA = new StateStore(dir, SCOPE);
    sessionA.queueDelivery({
      event_id: "evt_session_a",
      content: "first session message",
      meta: { chat_id: "cnv_1", sender: "usr_1" },
      conversation_id: "cnv_1",
      created_at: 1,
    });
    sessionA.update({ cursor: 17, last_conversation_id: "cnv_1" });
    sessionA.acknowledgeDelivery("evt_session_a");
    sessionA.registerApproval(
      { request_id: "abcde", tool_name: "Bash", description: "List", input_preview: '{"command":"ls"}' },
      "cnv_1",
      true,
    );

    const sessionB = new StateStore(dir, { ...SCOPE, sessionId: "project:/tmp/repo-two" });
    assert.equal(sessionB.get().cursor, 17);
    assert.equal(sessionB.hasSeenEvent("evt_session_a"), true);
    assert.equal(sessionB.pendingDeliveries().length, 0);
    assert.equal(sessionB.get().last_conversation_id, undefined);
    assert.equal(sessionB.pendingApproval("abcde"), undefined);
  });

  it("remembers acknowledged event ids across reloads and bounds the list", () => {
    const dir = tempDir();
    const store = new StateStore(dir, SCOPE);
    for (let i = 0; i < RECENT_EVENT_IDS_LIMIT + 10; i++) store.markEventSeen(`evt_${i}`);
    assert.equal(store.hasSeenEvent("evt_0"), false);
    assert.equal(store.hasSeenEvent(`evt_${RECENT_EVENT_IDS_LIMIT + 9}`), true);
    const reloaded = new StateStore(dir, SCOPE);
    assert.equal(reloaded.hasSeenEvent(`evt_${RECENT_EVENT_IDS_LIMIT + 9}`), true);
  });

  it("queues a delivery durably and removes it only on explicit acknowledgement", () => {
    const dir = tempDir();
    const store = new StateStore(dir, SCOPE);
    store.queueDelivery({
      event_id: "evt_pending",
      content: "deploy it",
      meta: { chat_id: "cnv_1", sender: "usr_1" },
      conversation_id: "cnv_1",
      created_at: 1,
    });
    const reloaded = new StateStore(dir, SCOPE);
    assert.equal(reloaded.pendingDeliveries().length, 1);
    assert.equal(reloaded.hasSeenEvent("evt_pending"), true);
    assert.equal(reloaded.acknowledgeDelivery("evt_pending"), true);
    assert.equal(new StateStore(dir, SCOPE).pendingDeliveries().length, 0);
    assert.equal(new StateStore(dir, SCOPE).hasSeenEvent("evt_pending"), true);
  });

  it("fails closed when corrupt cursor state could replay events older than the dedupe window", () => {
    const dir = tempDir();
    const store = new StateStore(dir, SCOPE);
    for (let i = 0; i < RECENT_EVENT_IDS_LIMIT + 10; i++) store.markEventSeen(`evt_${i}`);
    store.update({ cursor: RECENT_EVENT_IDS_LIMIT + 10 });
    assert.equal(store.hasSeenEvent("evt_0"), false);
    writeFileSync(store.statePath, "{broken", "utf8");
    assert.throws(() => new StateStore(dir, SCOPE), CorruptLedgerError);
    assert.ok(
      readdirSync(store.accountDir).some((name) =>
        name.startsWith("consumer-state.json.corrupt-"),
      ),
    );
    assert.ok(readdirSync(store.accountDir).includes("consumer-state.blocked"));
    // The persisted marker keeps later restarts blocked; they cannot reset to
    // cursor zero and replay evt_0 after it aged out of the 500-id ledger.
    assert.throws(() => new StateStore(dir, SCOPE), CorruptLedgerError);
  });

  it("fails closed and quarantines a corrupt event ledger", () => {
    const dir = tempDir();
    const store = new StateStore(dir, SCOPE);
    store.markEventSeen("evt_safe");
    writeFileSync(store.ledgerPath, "{broken", "utf8");
    assert.throws(() => new StateStore(dir, SCOPE), CorruptLedgerError);
    assert.ok(
      readdirSync(store.accountDir).some((name) =>
        name.startsWith("consumer-ledger.json.corrupt-"),
      ),
    );
    assert.ok(readdirSync(store.accountDir).includes("consumer-ledger.blocked"));
    // A later restart must remain blocked rather than silently creating a
    // fresh ledger and replaying old events.
    assert.throws(() => new StateStore(dir, SCOPE), CorruptLedgerError);
  });

  it("registers approvals before sending and preserves them across restart", () => {
    const dir = tempDir();
    const store = new StateStore(dir, SCOPE);
    store.registerApproval(
      { request_id: "abcde", tool_name: "Bash", description: "List", input_preview: '{"command":"ls"}' },
      "cnv_1",
      true,
      Date.now(),
    );
    const approval = new StateStore(dir, SCOPE).pendingApproval("abcde");
    assert.ok(approval);
    assert.equal(approval.conversation_id, "cnv_1");
    assert.equal(approval.card_sent_at, undefined);
  });

  it("binds a send_id to one payload and preserves its idempotency key", () => {
    const dir = tempDir();
    const store = new StateStore(dir, SCOPE);
    const first = store.registerOutboundSend("reply-1", "hash-a", "claude-reply-key", 1);
    const retry = new StateStore(dir, SCOPE).registerOutboundSend(
      "reply-1",
      "hash-a",
      "ignored-new-key",
      2,
    );
    assert.equal(retry.idempotency_key, first.idempotency_key);
    assert.throws(() => store.registerOutboundSend("reply-1", "hash-b", "other", 3));
  });
});

describe("exclusive consumer lock", () => {
  it("allows only one live consumer per origin and agent", () => {
    const dir = tempDir();
    const first = new ConsumerLock(dir, SCOPE);
    assert.throws(
      () => new ConsumerLock(dir, { ...SCOPE, sessionId: "another-session" }),
      /already has an active channel consumer/,
    );
    first.release();
    const next = new ConsumerLock(dir, { ...SCOPE, sessionId: "another-session" });
    next.release();
  });
});
