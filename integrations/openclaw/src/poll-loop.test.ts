import { describe, expect, it } from "vitest";
import { RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import { createRelayCursorStore } from "./cursor-store.js";
import type { RelayCursorRecord, RelayCursorStateStore } from "./cursor-store.js";
import { createRelayInboundDeduper } from "./inbound-dedupe.js";
import type { RelayClaimableGuard } from "./inbound-dedupe.js";
import { runRelayPollLoop } from "./poll-loop.js";
import type { RelayEvent, RelayEventsPage } from "./types.js";

function makeEvent(id: string): RelayEvent {
  return {
    event_id: id,
    event_type: "message.received",
    agent_id: "agt_self",
    created_at: "2026-07-17T00:00:00.000Z",
    data: {},
  };
}

function memoryCursorStore() {
  const map = new Map<string, RelayCursorRecord>();
  const store: RelayCursorStateStore = {
    lookup: async (key) => map.get(key),
    register: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => map.delete(key),
  };
  return createRelayCursorStore({ store, baseUrl: "https://api.relayapp.im", agentId: "agt_self" });
}

function memoryGuard(): RelayClaimableGuard {
  const claimed = new Set<string>();
  const committed = new Set<string>();
  return {
    claim: async (key) => {
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
      claimed.delete(key);
      committed.add(key);
    },
    release: (key) => {
      claimed.delete(key);
    },
  };
}

type PollTurn = RelayEventsPage | Error;

/** Client whose pollEvents replays a scripted sequence, then aborts the loop. */
function scriptedClient(turns: PollTurn[], abort: AbortController): RelayClient {
  let index = 0;
  return {
    getMe: async () => {
      throw new Error("not used");
    },
    pollEvents: async () => {
      if (index >= turns.length) {
        abort.abort();
        return { events: [], nextCursor: 0 };
      }
      const turn = turns[index]!;
      index += 1;
      if (turn instanceof Error) {
        throw turn;
      }
      return turn;
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
    setTyping: async () => {},
    markRead: async () => {},
  };
}

const instantSleep = async () => {};

describe("runRelayPollLoop", () => {
  it("advances the cursor only after the whole batch is durably handled", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const handled: string[] = [];
    const cursorAtHandle: number[] = [];

    await runRelayPollLoop({
      client: scriptedClient(
        [{ events: [makeEvent("evt_1"), makeEvent("evt_2")], nextCursor: 2 }],
        abort,
      ),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard: memoryGuard(), baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      handleEvent: async (event) => {
        handled.push(event.event_id);
        // Durable-before-ack: while handling, the persisted ack must still be
        // the pre-batch cursor.
        cursorAtHandle.push(cursorStore.current());
      },
      sleep: instantSleep,
    });

    expect(handled).toEqual(["evt_1", "evt_2"]);
    expect(cursorAtHandle).toEqual([0, 0]);
    expect(cursorStore.current()).toBe(2);
  });

  it("does not replay a dispatch that may already have run tool side effects", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const guard = memoryGuard();
    const handled: string[] = [];
    let failedOnce = false;
    const logs: string[] = [];

    await runRelayPollLoop({
      client: scriptedClient(
        [
          { events: [makeEvent("evt_1"), makeEvent("evt_2")], nextCursor: 2 },
          // Replay of the same batch after the mid-batch failure.
          { events: [makeEvent("evt_1"), makeEvent("evt_2")], nextCursor: 2 },
        ],
        abort,
      ),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard, baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      handleEvent: async (event, markAttempt) => {
        await markAttempt();
        if (event.event_id === "evt_2" && !failedOnce) {
          failedOnce = true;
          throw new Error("transient dispatch failure");
        }
        handled.push(event.event_id);
      },
      log: (line) => logs.push(line),
      sleep: instantSleep,
    });

    // evt_2 may have run tools before its handler failed, so its durable
    // attempt suppresses the server replay instead of executing it twice.
    expect(handled).toEqual(["evt_1"]);
    expect(cursorStore.current()).toBe(2);
    expect(logs.join("\n")).toMatch(/will not replay possible tool side effects/);
  });

  it("replays only when the durable attempt marker fails before dispatch", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const guard = memoryGuard();
    const originalCommit = guard.commit;
    let commitFailed = false;
    guard.commit = async (key, opts) => {
      if (key.includes("evt_2") && !commitFailed) {
        commitFailed = true;
        throw new Error("state db unavailable");
      }
      return originalCommit(key, opts);
    };
    const handled: string[] = [];

    await runRelayPollLoop({
      client: scriptedClient(
        [
          { events: [makeEvent("evt_1"), makeEvent("evt_2")], nextCursor: 2 },
          { events: [makeEvent("evt_1"), makeEvent("evt_2")], nextCursor: 2 },
        ],
        abort,
      ),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard, baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      handleEvent: async (event, markAttempt) => {
        await markAttempt();
        handled.push(event.event_id);
      },
      sleep: instantSleep,
    });

    expect(handled).toEqual(["evt_1", "evt_2"]);
    expect(cursorStore.current()).toBe(2);
  });

  it.each(["resolver", "route", "session", "envelope"])(
    "retries a safe %s preflight failure before marking the agent attempt",
    async (stage) => {
      const abort = new AbortController();
      const cursorStore = memoryCursorStore();
      await cursorStore.load();
      let calls = 0;
      const handled: string[] = [];
      await runRelayPollLoop({
        client: scriptedClient(
          [
            { events: [makeEvent("evt_preflight")], nextCursor: 1 },
            { events: [makeEvent("evt_preflight")], nextCursor: 1 },
          ],
          abort,
        ),
        cursorStore,
        deduper: createRelayInboundDeduper({
          guard: memoryGuard(),
          baseUrl: "https://api.relayapp.im",
          agentId: "agt_self",
        }),
        abortSignal: abort.signal,
        handleEvent: async (event, markAttempt) => {
          calls += 1;
          if (calls === 1) throw new Error(`${stage} unavailable`);
          await markAttempt();
          handled.push(event.event_id);
        },
        sleep: instantSleep,
      });
      expect(calls).toBe(2);
      expect(handled).toEqual(["evt_preflight"]);
      expect(cursorStore.current()).toBe(1);
    },
  );

  it("acks bookkeeping events without burning dedupe claims", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const claims: string[] = [];
    const guard = memoryGuard();
    const originalClaim = guard.claim;
    guard.claim = async (key, opts) => {
      claims.push(key);
      return originalClaim(key, opts);
    };
    const handled: string[] = [];

    const receipt: RelayEvent = { ...makeEvent("evt_read"), event_type: "message.read" };
    await runRelayPollLoop({
      client: scriptedClient(
        [{ events: [receipt, makeEvent("evt_msg")], nextCursor: 2 }],
        abort,
      ),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard, baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      shouldProcess: (event) => event.event_type === "message.received",
      handleEvent: async (event, markAttempt) => {
        await markAttempt();
        handled.push(event.event_id);
      },
      sleep: instantSleep,
    });

    expect(handled).toEqual(["evt_msg"]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("evt_msg");
    // The receipt still counts toward the ack.
    expect(cursorStore.current()).toBe(2);
  });

  it("suppresses committed duplicates when the server replays a batch", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const handled: string[] = [];

    await runRelayPollLoop({
      client: scriptedClient(
        [
          { events: [makeEvent("evt_1")], nextCursor: 1 },
          { events: [makeEvent("evt_1")], nextCursor: 1 },
        ],
        abort,
      ),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard: memoryGuard(), baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      handleEvent: async (event, markAttempt) => {
        await markAttempt();
        handled.push(event.event_id);
      },
      sleep: instantSleep,
    });

    expect(handled).toEqual(["evt_1"]);
  });

  it("settles on 401 so the supervisor can mark a terminal disconnect", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();

    await expect(
      runRelayPollLoop({
        client: scriptedClient(
          [new RelayApiError("unauthorized", { status: 401, kind: "auth" })],
          abort,
        ),
        cursorStore,
        deduper: createRelayInboundDeduper({ guard: memoryGuard(), baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
        abortSignal: abort.signal,
        handleEvent: async () => {},
        sleep: instantSleep,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("settles on 409 consumer conflict", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();

    await expect(
      runRelayPollLoop({
        client: scriptedClient(
          [new RelayApiError("terminated_by_other_consumer", { status: 409, kind: "conflict" })],
          abort,
        ),
        cursorStore,
        deduper: createRelayInboundDeduper({ guard: memoryGuard(), baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
        abortSignal: abort.signal,
        handleEvent: async () => {},
        sleep: instantSleep,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("keeps looping through transient errors", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const handled: string[] = [];

    await runRelayPollLoop({
      client: scriptedClient(
        [
          new RelayApiError("rate limited", { status: 429, kind: "retryable" }),
          new RelayApiError("bad gateway", { status: 502, kind: "retryable" }),
          { events: [makeEvent("evt_1")], nextCursor: 1 },
        ],
        abort,
      ),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard: memoryGuard(), baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      handleEvent: async (event, markAttempt) => {
        await markAttempt();
        handled.push(event.event_id);
      },
      sleep: instantSleep,
    });

    expect(handled).toEqual(["evt_1"]);
    expect(cursorStore.current()).toBe(1);
  });

  it("returns promptly when aborted", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    abort.abort();

    await runRelayPollLoop({
      client: scriptedClient([], abort),
      cursorStore,
      deduper: createRelayInboundDeduper({ guard: memoryGuard(), baseUrl: "https://api.relayapp.im", agentId: "agt_self" }),
      abortSignal: abort.signal,
      handleEvent: async () => {
        throw new Error("must not dispatch after abort");
      },
      sleep: instantSleep,
    });
  });

  it("does not acknowledge the unprocessed tail when abort fires after an attempt commit", async () => {
    const abort = new AbortController();
    const cursorStore = memoryCursorStore();
    await cursorStore.load();
    const committed: string[] = [];
    const deduper = {
      claimEvent: async () => true,
      commitEvent: async (eventId: string) => {
        committed.push(eventId);
        abort.abort();
      },
      releaseEvent: () => {},
    };
    const handled: string[] = [];

    await runRelayPollLoop({
      client: scriptedClient(
        [{ events: [makeEvent("evt_1"), makeEvent("evt_tail")], nextCursor: 2 }],
        abort,
      ),
      cursorStore,
      deduper,
      abortSignal: abort.signal,
      handleEvent: async (event, markAttempt) => {
        await markAttempt();
        handled.push(event.event_id);
      },
      sleep: instantSleep,
    });

    expect(committed).toEqual(["evt_1"]);
    expect(handled).toEqual([]);
    expect(cursorStore.current()).toBe(0);
  });
});
