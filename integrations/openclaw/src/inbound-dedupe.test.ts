import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRelayInboundDedupeKey,
  createRelayInboundDedupeGuard,
  createRelayInboundDeduper,
} from "./inbound-dedupe.js";
import type { RelayClaimableGuard } from "./inbound-dedupe.js";

function fakeGuard() {
  const claimed = new Set<string>();
  const committed = new Set<string>();
  const log: string[] = [];
  const guard: RelayClaimableGuard = {
    claim: async (key) => {
      log.push(`claim:${key}`);
      if (committed.has(key)) {
        return { kind: "duplicate" };
      }
      if (claimed.has(key)) {
        return { kind: "inflight" };
      }
      claimed.add(key);
      return { kind: "claimed" };
    },
    commit: async (key) => {
      log.push(`commit:${key}`);
      claimed.delete(key);
      committed.add(key);
      return true;
    },
    release: (key) => {
      log.push(`release:${key}`);
      claimed.delete(key);
    },
  };
  return { guard, claimed, committed, log };
}

describe("relay inbound dedupe key", () => {
  it("scopes origin, agent, and event with NUL so account renames cannot replay", () => {
    expect(buildRelayInboundDedupeKey({ baseUrl: "https://api.relayapp.im", agentId: "agt_1", eventId: "evt_1" })).toBe(
      "https://api.relayapp.im\0agt_1\0evt_1",
    );
    expect(buildRelayInboundDedupeKey({ baseUrl: "https://api.relayapp.im", agentId: "a:b", eventId: "c" })).not.toBe(
      buildRelayInboundDedupeKey({ baseUrl: "https://api.relayapp.im", agentId: "a", eventId: "b:c" }),
    );
  });

  it("rejects blank event ids", () => {
    expect(buildRelayInboundDedupeKey({ baseUrl: "https://api.relayapp.im", agentId: "agt_1", eventId: "  " })).toBeNull();
  });
});

describe("relay inbound deduper", () => {
  const params = { baseUrl: "https://api.relayapp.im", agentId: "agt_1" };
  it("claims, commits, and suppresses replayed events", async () => {
    const { guard } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, ...params });

    expect(await deduper.claimEvent("evt_1")).toBe(true);
    await deduper.commitEvent("evt_1");
    // A cursor replay redelivers the same event: committed events never
    // re-dispatch.
    expect(await deduper.claimEvent("evt_1")).toBe(false);
  });

  it("release reopens an uncommitted event for retry", async () => {
    const { guard } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, ...params });

    expect(await deduper.claimEvent("evt_2")).toBe(true);
    deduper.releaseEvent("evt_2");
    expect(await deduper.claimEvent("evt_2")).toBe(true);
  });

  it("does not double-dispatch an in-flight event", async () => {
    const { guard } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, ...params });

    expect(await deduper.claimEvent("evt_3")).toBe(true);
    expect(await deduper.claimEvent("evt_3")).toBe(false);
  });

  it("fails closed for events it cannot identify", async () => {
    const { guard, log } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, ...params });

    expect(await deduper.claimEvent("")).toBe(false);
    await deduper.commitEvent("");
    deduper.releaseEvent("");
    expect(log).toHaveLength(0);
  });

  it("scopes keys per stable agent identity", async () => {
    const { guard } = fakeGuard();
    const a = createRelayInboundDeduper({ guard, ...params });
    const b = createRelayInboundDeduper({ guard, ...params, agentId: "agt_2" });

    expect(await a.claimEvent("evt")).toBe(true);
    expect(await b.claimEvent("evt")).toBe(true);
  });
});

describe("strict durable attempt guard", () => {
  it("records an attempt before a restart can claim the same event", async () => {
    const rows = new Map<string, { attemptedAt: number }>();
    const guard = createRelayInboundDedupeGuard({
      store: {
        lookup: (key) => rows.get(key),
        register: (key, value) => {
          rows.set(key, value);
        },
      },
    });

    expect((await guard.claim("account\0event", { namespace: "global" })).kind).toBe("claimed");
    await guard.commit("account\0event", { namespace: "global" });
    expect((await guard.claim("account\0event", { namespace: "global" })).kind).toBe(
      "duplicate",
    );
  });

  it("serializes concurrent claims while the durable lookup is pending", async () => {
    let releaseLookup!: () => void;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const guard = createRelayInboundDedupeGuard({
      store: {
        lookup: async () => {
          await lookupBlocked;
          return undefined;
        },
        register: () => {},
      },
    });

    const first = guard.claim("account\0event", { namespace: "global" });
    const second = guard.claim("account\0event", { namespace: "global" });
    expect((await second).kind).toBe("inflight");
    releaseLookup();
    expect((await first).kind).toBe("claimed");
  });

  it("propagates a persistence failure instead of dispatching with memory-only state", async () => {
    const errors: unknown[] = [];
    const guard = createRelayInboundDedupeGuard({
      store: {
        lookup: () => undefined,
        register: () => {
          throw new Error("sqlite unavailable");
        },
      },
      onDiskError: (error) => errors.push(error),
    });

    expect((await guard.claim("account\0event", { namespace: "global" })).kind).toBe("claimed");
    await expect(guard.commit("account\0event", { namespace: "global" })).rejects.toThrow(
      /sqlite unavailable/,
    );
    expect(errors).toHaveLength(1);
  });

  it("persists attempts across guard instances without trusted host state", async () => {
    const stateDir = mkdtempSync(`${tmpdir()}/relay-attempt-persistence-`);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const first = createRelayInboundDedupeGuard({ env });
      expect((await first.claim("account\0event", { namespace: "global" })).kind).toBe("claimed");
      await first.commit("account\0event", { namespace: "global" });

      const restarted = createRelayInboundDedupeGuard({ env });
      expect((await restarted.claim("account\0event", { namespace: "global" })).kind).toBe(
        "duplicate",
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupt Relay-owned attempt state", async () => {
    const stateDir = mkdtempSync(`${tmpdir()}/relay-attempt-corrupt-`);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const errors: unknown[] = [];
    try {
      const guard = createRelayInboundDedupeGuard({
        env,
        onDiskError: (error) => errors.push(error),
      });
      writeFileSync(
        join(stateDir, "relay", "state", "inbound-attempts.json"),
        '{"version":1,"entries":{"not-a-hash":{"attemptedAt":1,"expiresAt":2}}}\n',
        { mode: 0o600 },
      );
      await expect(guard.claim("account\0event", { namespace: "global" })).rejects.toThrow(
        /state is corrupt/u,
      );
      expect(errors).toHaveLength(1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("expires old attempts and evicts the oldest live row at capacity", async () => {
    const stateDir = mkdtempSync(`${tmpdir()}/relay-attempt-bounds-`);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    let now = 1_000;
    try {
      const guard = createRelayInboundDedupeGuard({
        env,
        maxEntries: 2,
        ttlMs: 100,
        now: () => now,
      });
      for (const event of ["oldest", "middle", "newest"]) {
        expect((await guard.claim(event, { namespace: "global" })).kind).toBe("claimed");
        await guard.commit(event, { namespace: "global" });
        now += 1;
      }

      const afterEviction = createRelayInboundDedupeGuard({
        env,
        maxEntries: 2,
        ttlMs: 100,
        now: () => now,
      });
      expect((await afterEviction.claim("oldest", { namespace: "global" })).kind).toBe("claimed");
      expect((await afterEviction.claim("middle", { namespace: "global" })).kind).toBe("duplicate");
      expect((await afterEviction.claim("newest", { namespace: "global" })).kind).toBe("duplicate");

      now = 1_200;
      const afterTtl = createRelayInboundDedupeGuard({
        env,
        maxEntries: 2,
        ttlMs: 100,
        now: () => now,
      });
      expect((await afterTtl.claim("middle", { namespace: "global" })).kind).toBe("claimed");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid bounds before opening durable state", () => {
    expect(() => createRelayInboundDedupeGuard({ ttlMs: 0 })).toThrow(/ttlMs/u);
    expect(() => createRelayInboundDedupeGuard({ maxEntries: 0 })).toThrow(/maxEntries/u);
  });
});
