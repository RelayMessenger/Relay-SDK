import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_TURN_TTL_MS, RelayStateStore } from "../src/state.ts";
import type { DeliveryCandidate, RelaySnapshot } from "../src/types.ts";

const roots: string[] = [];
const EVENT_ID = "00000000-0000-7000-8000-000000000004";
const MESSAGE_ID = "00000000-0000-7000-8000-000000000003";
const CHAT_ID = "00000000-0000-7000-8000-000000000002";

function open(): RelayStateStore {
  const stateDir = mkdtempSync(join(tmpdir(), "relay-state-"));
  roots.push(stateDir);
  return new RelayStateStore({ stateDir, sessionKey: "session-a" });
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function event(id = EVENT_ID, text = "hello"): RelayWebhookEvent {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: id,
    created_at: "2026-09-01T00:00:00.000Z",
    trace_id: "trace",
    agent_id: "00000000-0000-7000-8000-000000000005",
    data: { text },
  } as unknown as RelayWebhookEvent;
}

function delivery(): DeliveryCandidate {
  return {
    deliveryId: EVENT_ID,
    eventId: EVENT_ID,
    messageId: MESSAGE_ID,
    chatId: CHAT_ID,
    senderId: "00000000-0000-7000-8000-000000000001",
    senderHandle: "@owner",
    content: "hello",
    meta: { chat_id: CHAT_ID, delivery_id: EVENT_ID },
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("durable Relay cursor and event acceptance", () => {
  it("commits event identity and cumulative local cursor together", () => {
    const state = open();
    expect(state.acceptedThrough()).toBe("0");
    expect(state.acceptEvent(event(), "1", 1)).toBe("accepted");
    expect(state.acceptedThrough()).toBe("1");
    expect(state.pendingIngress()).toEqual([{ sequence: "1", event: event() }]);
    expect(state.acceptEvent(event(), "1", 2)).toBe("duplicate");
    state.close();
  });

  it("fails closed on sequence gaps, changed replays, and duplicate ids at new sequences", () => {
    const state = open();
    expect(() => state.acceptEvent(event(), "2")).toThrow(/cursor gap/u);
    state.acceptEvent(event(), "1");
    expect(() => state.acceptEvent(event(EVENT_ID, "changed"), "1")).toThrow(/different event content/u);
    expect(() => state.acceptEvent(event(), "2")).toThrow(/different sequence/u);
    state.close();
  });
});

describe("durable Claude delivery start", () => {
  it("keeps notification pending until explicit Read-start completion", () => {
    const state = open();
    state.acceptEvent(event(), "1");
    state.recordDelivery(delivery());
    expect(state.pendingDeliveries(10).map((item) => item.deliveryId)).toEqual([EVENT_ID]);
    state.noteDeliveryNotified(EVENT_ID, 20);
    expect(state.pendingDeliveries(19)).toHaveLength(0);
    expect(state.beginDelivery(EVENT_ID, 30)?.status).toBe("starting");
    expect(state.pendingDeliveries(100).map((item) => item.status)).toEqual(["starting"]);
    state.markDeliveryProcessing(EVENT_ID, 40);
    expect(state.delivery(EVENT_ID)?.status).toBe("processing");
    expect(state.pendingDeliveries(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    expect(state.hasObservedChat(CHAT_ID)).toBe(true);
    state.close();
  });
});

describe("idempotent outbound ledger", () => {
  it("persists one logical send before confirmation and rejects changed reuse", () => {
    const state = open();
    expect(state.registerOutboundSend({
      sendId: "send-1",
      payloadHash: "hash-a",
      idempotencyKey: "key-a",
      now: 1,
    })).toEqual({ idempotencyKey: "key-a", confirmed: false });
    expect(state.registerOutboundSend({
      sendId: "send-1",
      payloadHash: "hash-a",
      idempotencyKey: "key-a",
      now: 2,
    }).confirmed).toBe(false);
    expect(() => state.registerOutboundSend({
      sendId: "send-1",
      payloadHash: "hash-b",
      idempotencyKey: "key-a",
    })).toThrow(/different Relay Message content/u);
    state.confirmOutboundSend("send-1", 3);
    expect(state.registerOutboundSend({
      sendId: "send-1",
      payloadHash: "hash-a",
      idempotencyKey: "key-a",
    }).confirmed).toBe(true);
    state.close();
  });
});

describe("turn origin isolation", () => {
  it("supersedes prior Chats and prevents closed delivery reactivation", () => {
    const state = open();
    const originA = { ...delivery(), eventId: null };
    const originB = {
      ...delivery(),
      deliveryId: "00000000-0000-7000-8000-000000000014",
      eventId: null,
      messageId: "00000000-0000-7000-8000-000000000013",
      chatId: "00000000-0000-7000-8000-000000000012",
      senderId: "00000000-0000-7000-8000-000000000011",
      senderHandle: "@second-owner",
      meta: {
        chat_id: "00000000-0000-7000-8000-000000000012",
        delivery_id: "00000000-0000-7000-8000-000000000014",
      },
      createdAt: "2026-09-01T00:00:01.000Z",
    };
    state.recordDelivery(originA);
    state.beginDelivery(originA.deliveryId, 10);
    state.markDeliveryProcessing(originA.deliveryId, 11);
    const activeA = state.activeTurnOrigin(12);
    expect(activeA).toMatchObject({
      chatId: originA.chatId,
      senderId: originA.senderId,
      senderHandle: originA.senderHandle,
    });
    if (!activeA) throw new Error("missing first active origin");

    state.recordDelivery(originB);
    state.beginDelivery(originB.deliveryId, 30);
    state.markDeliveryProcessing(originB.deliveryId, 31);
    const activeB = state.activeTurnOrigin(32);
    if (!activeB) throw new Error("missing second active origin");
    expect(activeB).toMatchObject({
      chatId: originB.chatId,
      senderId: originB.senderId,
      senderHandle: originB.senderHandle,
    });
    expect(() => state.activateDeliveryOrigin(originA.deliveryId, 33))
      .toThrow(/already has a closed Relay turn/u);
    expect(state.completeDeliveryTurn(originB.deliveryId, "completed", 34)).toBe("closed");
    expect(state.activeTurnOrigin(35)).toBeNull();
    state.close();
  });

  it("expires turn origins without allowing reactivation", () => {
    const state = open();
    const candidate = { ...delivery(), eventId: null };
    state.recordDelivery(candidate);
    state.beginDelivery(candidate.deliveryId, 10);
    state.markDeliveryProcessing(candidate.deliveryId, 11, 100);
    const active = state.activeTurnOrigin(110);
    if (!active) throw new Error("missing active origin");
    expect(ACTIVE_TURN_TTL_MS).toBeGreaterThan(100);
    expect(state.activeTurnOrigin(111)).toBeNull();
    expect(() => state.activateDeliveryOrigin(candidate.deliveryId, 113))
      .toThrow(/already has a closed Relay turn/u);
    expect(state.completeDeliveryTurn(candidate.deliveryId, "failed", 114))
      .toBe("already_closed");
    state.close();
  });
});

describe("schema compatibility guard", () => {
  it("rejects a checkpointed future schema before any DDL or file mutation", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-future-state-"));
    roots.push(stateDir);
    const path = join(stateDir, "channel.sqlite");
    const fixture = new DatabaseSync(path);
    fixture.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '999');
      CREATE TABLE future_private_state (secret TEXT NOT NULL);
      INSERT INTO future_private_state(secret) VALUES ('must-not-change');
    `);
    fixture.close();
    const beforeBytes = readFileSync(path);
    const beforeHash = createHash("sha256").update(beforeBytes).digest("hex");
    const beforeFiles = readdirSync(stateDir).sort();

    expect(() => new RelayStateStore({ stateDir, sessionKey: "future-session" }))
      .toThrow(/schema 999 is unsupported; refusing to mutate/u);

    expect(readdirSync(stateDir).sort()).toEqual(beforeFiles);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(beforeHash);
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      expect(verify.prepare("SELECT secret FROM future_private_state").get()).toEqual({
        secret: "must-not-change",
      });
      expect(verify.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
      `).all()).toEqual([
        { name: "future_private_state" },
        { name: "metadata" },
      ]);
    } finally {
      verify.close();
    }
  });

  it("observes a live uncheckpointed WAL future schema with zero durable mutation", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-live-wal-state-"));
    roots.push(stateDir);
    const path = join(stateDir, "channel.sqlite");
    const writer = new DatabaseSync(path);
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
      `);
      writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      writer.exec(`
        UPDATE metadata SET value = '999' WHERE key = 'schema_version';
        CREATE TABLE future_private_state (secret TEXT NOT NULL);
        INSERT INTO future_private_state(secret) VALUES ('live-wal-must-not-change');
      `);
      const originalHashes = (): Record<string, string> => Object.fromEntries(
        readdirSync(stateDir).sort().map((name) => [
          name,
          createHash("sha256").update(readFileSync(join(stateDir, name))).digest("hex"),
        ]),
      );
      const beforeFiles = readdirSync(stateDir).sort();
      const beforeDataVersion = writer.prepare("PRAGMA data_version").get();
      const beforeHashes = originalHashes();
      expect(beforeFiles).toEqual([
        "channel.sqlite",
        "channel.sqlite-shm",
        "channel.sqlite-wal",
      ]);
      expect(readFileSync(`${path}-wal`).length).toBeGreaterThan(0);

      expect(() => new RelayStateStore({ stateDir, sessionKey: "live-wal-session" }))
        .toThrow(/schema 999 is unsupported; refusing to mutate/u);

      expect(readdirSync(stateDir).sort()).toEqual(beforeFiles);
      expect(originalHashes()).toEqual(beforeHashes);
      expect(writer.prepare("PRAGMA data_version").get()).toEqual(beforeDataVersion);
      expect(writer.prepare(
        "SELECT value FROM metadata WHERE key = 'schema_version'",
      ).get()).toEqual({ value: "999" });
      expect(writer.prepare("SELECT secret FROM future_private_state").get()).toEqual({
        secret: "live-wal-must-not-change",
      });
      expect(writer.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
      `).all()).toEqual([
        { name: "future_private_state" },
        { name: "metadata" },
      ]);
    } finally {
      writer.close();
    }
  });
});

describe("FULL sync atomic state", () => {
  it("replaces the complete snapshot, advances the cursor, and stages unread reconciliation", () => {
    const state = open();
    const snapshot: RelaySnapshot = {
      version: 1,
      throughSequence: "42",
      reason: "checkpoint_outside_retention",
      completedAt: "2026-09-01T00:00:00.000Z",
      chats: [],
    };
    const synthetic = { ...delivery(), deliveryId: `fullsync-${MESSAGE_ID}`, eventId: null };
    state.replaceWithFullSync(snapshot, [synthetic]);
    expect(state.acceptedThrough()).toBe("42");
    expect(state.readSnapshot()).toEqual(snapshot);
    expect(state.pendingDeliveries(Number.MAX_SAFE_INTEGER)[0]?.deliveryId)
      .toBe(`fullsync-${MESSAGE_ID}`);
    expect(() => state.replaceWithFullSync({ ...snapshot, throughSequence: "41" }, []))
      .toThrow(/behind durable local checkpoint/u);
    state.close();
  });
});
