import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RelayAccountLock } from "./account-lock.js";

describe("cross-process Relay account lock", () => {
  it("fails a second holder closed until the first releases", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-openclaw-lock-"));
    const first = new RelayAccountLock("https://api.relayapp.im", "agt_1", "one", home);
    const second = new RelayAccountLock("https://api.relayapp.im", "agt_1", "two", home);
    first.acquire();
    expect(() => second.acquire()).toThrow(/already being run by/);
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
  });

  it("recovers a lock whose recorded process is dead", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-openclaw-stale-lock-"));
    const lock = new RelayAccountLock("https://api.relayapp.im", "agt_stale", "next", home);
    // Derive the private lock path only to construct a crash remnant fixture.
    const lockPath = (lock as any).lockPath as string;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: "dead",
        account_id: "crashed",
        created_at: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });
});
