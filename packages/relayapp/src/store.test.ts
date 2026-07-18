import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteJson, blockInvalidState, RuntimeLock, StateStore } from "./store.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "relayapp-store-test-"));
}

test("corrupt security state is quarantined and persistently blocks cursor-zero replay", () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), '{"cursor":42,"attempted_turns":');

  assert.throws(() => new StateStore(home), /corrupt|blocked/i);
  const names = readdirSync(home);
  assert.ok(names.some((name) => name.startsWith("state.json.corrupt-")));
  assert.ok(names.includes("state.blocked.json"));
  assert.throws(
    () => new StateStore(home),
    /blocked after corruption/i,
    "a later process must not silently restart from cursor zero",
  );
});

test("semantically invalid cursor state cannot silently reset to zero", () => {
  const home = tempHome();
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({ cursor: "42", seen_event_ids: [], pending_events: {} }),
  );
  assert.throws(() => new StateStore(home), /quarantined|blocked/i);
  assert.ok(existsSync(join(home, "state.blocked.json")));
  assert.throws(() => new StateStore(home), /blocked/i);
});

test("block marker failure leaves corrupt state in place for a fail-closed retry", () => {
  const home = tempHome();
  const statePath = join(home, "state.json");
  writeFileSync(statePath, "corrupt");
  assert.throws(
    () => blockInvalidState(home, statePath, "invalid", {
      writeBlock: () => { throw new Error("disk refused marker"); },
    }),
    /disk refused marker/,
  );
  assert.equal(existsSync(statePath), true, "state must not move before the marker is durable");
  assert.equal(existsSync(join(home, "state.blocked.json")), false);
  assert.throws(() => new StateStore(home), /blocked|quarantined/i);
  assert.equal(existsSync(join(home, "state.blocked.json")), true);
});

test("quarantine failure leaves a durable block marker and never resets cursor zero", () => {
  const home = tempHome();
  const statePath = join(home, "state.json");
  writeFileSync(statePath, "corrupt");
  assert.throws(
    () => blockInvalidState(home, statePath, "invalid", {
      quarantine: () => { throw new Error("rename failed"); },
    }),
    /could not be quarantined/,
  );
  assert.equal(existsSync(statePath), true);
  assert.equal(existsSync(join(home, "state.blocked.json")), true);
  assert.throws(() => new StateStore(home), /blocked after corruption/i);
});

test("crash between durable marker and quarantine stays blocked on next startup", () => {
  const home = tempHome();
  const statePath = join(home, "state.json");
  writeFileSync(statePath, "corrupt");
  assert.throws(
    () => blockInvalidState(home, statePath, "invalid", {
      afterBlockPersisted: () => { throw new Error("simulated process crash"); },
    }),
    /simulated process crash/,
  );
  assert.equal(existsSync(statePath), true);
  assert.equal(existsSync(join(home, "state.blocked.json")), true);
  assert.throws(() => new StateStore(home), /blocked after corruption/i);
});

test("origin+agent runtime lock rejects a second process and safely recovers a dead owner", () => {
  const home = tempHome();
  const first = new RuntimeLock(home);
  const second = new RuntimeLock(home);
  first.acquire();
  assert.throws(() => second.acquire(), /another relayapp start process/i);
  first.release();
  second.acquire();
  second.release();

  const staleDir = join(home, "start.lock");
  mkdirSync(staleDir, { recursive: true, mode: 0o700 });
  atomicWriteJson(
    join(staleDir, "owner.json"),
    { pid: 999_999_999, nonce: "dead-owner", acquired_at: new Date(0).toISOString() },
    0o600,
  );
  const replacement = new RuntimeLock(home);
  replacement.acquire();
  assert.ok(readdirSync(home).some((name) => name.startsWith("start.lock.stale-")));
  replacement.release();
});
