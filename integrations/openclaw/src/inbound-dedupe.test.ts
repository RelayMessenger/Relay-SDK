import { describe, expect, it } from "vitest";
import {
  buildRelayInboundDedupeKey,
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

  it("fails open for events it cannot identify", async () => {
    const { guard, log } = fakeGuard();
    const deduper = createRelayInboundDeduper({ guard, accountId: "default" });

    expect(await deduper.claimEvent("")).toBe(true);
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
