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
  it("separates account and event with NUL so printable ids cannot collide", () => {
    expect(buildRelayInboundDedupeKey({ accountId: "a", eventId: "evt_1" })).toBe("a\0evt_1");
    expect(buildRelayInboundDedupeKey({ accountId: "a:b", eventId: "c" })).not.toBe(
      buildRelayInboundDedupeKey({ accountId: "a", eventId: "b:c" }),
    );
  });

  it("defaults blank account ids and rejects blank event ids", () => {
    expect(buildRelayInboundDedupeKey({ accountId: "  ", eventId: "evt" })).toBe("default\0evt");
    expect(buildRelayInboundDedupeKey({ accountId: "a", eventId: "  " })).toBeNull();
  });
});

describe("relay inbound deduper", () => {
  it("claims, commits, and suppresses replayed events", async () => {
    const { guard } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, accountId: "default" });

    expect(await deduper.claimEvent("evt_1")).toBe(true);
    await deduper.commitEvent("evt_1");
    // A cursor replay redelivers the same event: committed events never
    // re-dispatch.
    expect(await deduper.claimEvent("evt_1")).toBe(false);
  });

  it("release reopens an uncommitted event for retry", async () => {
    const { guard } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, accountId: "default" });

    expect(await deduper.claimEvent("evt_2")).toBe(true);
    deduper.releaseEvent("evt_2");
    expect(await deduper.claimEvent("evt_2")).toBe(true);
  });

  it("does not double-dispatch an in-flight event", async () => {
    const { guard } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, accountId: "default" });

    expect(await deduper.claimEvent("evt_3")).toBe(true);
    expect(await deduper.claimEvent("evt_3")).toBe(false);
  });

  it("fails closed for events it cannot identify", async () => {
    const { guard, log } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, accountId: "default" });

    expect(await deduper.claimEvent("")).toBe(false);
    await deduper.commitEvent("");
    deduper.releaseEvent("");
    expect(log).toHaveLength(0);
  });

  it("scopes keys per account", async () => {
    const { guard } = fakeGuard();
    const a = createRelayInboundDeduper({ guard, accountId: "a" });
    const b = createRelayInboundDeduper({ guard, accountId: "b" });

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
});
