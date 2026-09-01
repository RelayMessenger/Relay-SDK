import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { stableHash } from "./bridge.ts";
import type {
  DeliveryCandidate,
  OutboundRegistration,
  RelaySnapshot,
  StoredDelivery,
  StoredIngressEvent,
  TurnOrigin,
  TurnOutcome,
} from "./types.ts";

const SCHEMA_VERSION = 4;
const MIGRATABLE_SCHEMA_VERSIONS = new Set(["1", "2", "3", String(SCHEMA_VERSION)]);
const MAX_PENDING_DELIVERIES = 10_000;
const MAX_UNREAD_FULL_SYNC_DELIVERIES = 100_000;
export const ACTIVE_TURN_TTL_MS = 10 * 60_000;
const PREFLIGHT_SNAPSHOT_ATTEMPTS = 3;
const SQLITE_STATE_SUFFIXES = ["", "-wal", "-shm"] as const;

interface StableStateSnapshot {
  readonly directory: string;
  readonly databasePath: string;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function originalStateFiles(path: string): string[] {
  return SQLITE_STATE_SUFFIXES
    .map((suffix) => `${path}${suffix}`)
    .filter((candidate) => existsSync(candidate));
}

function stableStateSnapshot(path: string): StableStateSnapshot {
  for (let attempt = 1; attempt <= PREFLIGHT_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const beforePaths = originalStateFiles(path);
      if (!beforePaths.includes(path)) {
        throw new Error(`durable Relay state disappeared during schema preflight: ${path}`);
      }
      const beforeBytes = new Map(
        beforePaths.map((candidate) => [candidate, readFileSync(candidate)]),
      );
      const afterPaths = originalStateFiles(path);
      const stableNames = beforePaths.length === afterPaths.length
        && beforePaths.every((candidate, index) => candidate === afterPaths[index]);
      const stableHashes = stableNames && afterPaths.every((candidate) => {
        const before = beforeBytes.get(candidate);
        return before !== undefined && digest(before) === digest(readFileSync(candidate));
      });
      if (!stableHashes) {
        if (attempt < PREFLIGHT_SNAPSHOT_ATTEMPTS) continue;
        break;
      }
      const directory = mkdtempSync(join(tmpdir(), "relay-schema-preflight-"));
      try {
        chmodSync(directory, 0o700);
        const databaseName = basename(path);
        for (const [candidate, bytes] of beforeBytes) {
          const suffix = candidate.slice(path.length);
          writeFileSync(join(directory, `${databaseName}${suffix}`), bytes, { mode: 0o600 });
        }
        return {
          directory,
          databasePath: join(directory, databaseName),
        };
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if (attempt >= PREFLIGHT_SNAPSHOT_ATTEMPTS) throw error;
    }
  }
  throw new Error(
    `durable Relay state changed during ${PREFLIGHT_SNAPSHOT_ATTEMPTS} schema preflight snapshots; refusing to mutate ${path}`,
  );
}

function inspectExistingState(path: string): number | null {
  if (!existsSync(path)) return null;
  const snapshot = stableStateSnapshot(path);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(snapshot.databasePath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    const quickCheck = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!quickCheck || !Object.values(quickCheck).includes("ok")) {
      throw new Error(`durable Relay state failed SQLite quick_check: ${path}`);
    }
    const tables = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as unknown as Array<{ name: string }>;
    if (tables.length === 0) return null;
    if (!tables.some((table) => table.name === "metadata")) {
      throw new Error(
        `durable Relay state has tables but no schema metadata; refusing to mutate ${path}`,
      );
    }
    const schemaRow = db.prepare(
      "SELECT value FROM metadata WHERE key = 'schema_version'",
    ).get() as Record<string, unknown> | undefined;
    const existingSchema = rowString(schemaRow, "value");
    if (existingSchema === null || !MIGRATABLE_SCHEMA_VERSIONS.has(existingSchema)) {
      throw new Error(
        `durable Relay state schema ${existingSchema ?? "missing"} is unsupported; refusing to mutate ${path}`,
      );
    }
    return Number(existingSchema);
  } finally {
    db?.close();
    rmSync(snapshot.directory, { recursive: true, force: true });
  }
}

function validSequence(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value);
}

function asBigInt(value: string, label: string): bigint {
  if (!validSequence(value)) throw new Error(`${label} is not a Relay WebSocket sequence`);
  return BigInt(value);
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

function rowString(row: Record<string, unknown> | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

interface DeliveryRow {
  delivery_id: string;
  event_id: string | null;
  message_id: string;
  chat_id: string;
  sender_id: string;
  sender_handle: string;
  content: string;
  meta_json: string;
  created_at: string;
  status: StoredDelivery["status"];
  last_notified_at: number | null;
  processing_started_at: number | null;
  read_marked_at: number | null;
}

interface ActiveTurnLease {
  readonly version: 1;
  readonly deliveryId: string;
  readonly activatedAt: number;
  readonly expiresAt: number;
}

function deliveryFromRow(row: DeliveryRow): StoredDelivery {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    messageId: row.message_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    senderHandle: row.sender_handle,
    content: row.content,
    meta: JSON.parse(row.meta_json) as Record<string, string>,
    createdAt: row.created_at,
    status: row.status,
    lastNotifiedAt: row.last_notified_at,
    processingStartedAt: row.processing_started_at,
    readMarkedAt: row.read_marked_at,
  };
}

export class RelayStateStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #sessionKey: string;

  constructor(params: { stateDir: string; sessionKey: string }) {
    this.path = join(params.stateDir, "channel.sqlite");
    this.#sessionKey = params.sessionKey;
    const existingSchema = inspectExistingState(this.path);
    this.#db = new DatabaseSync(this.path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec("PRAGMA busy_timeout = 30000");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transport_events (
        sequence TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','delivery','complete','blocked')),
        accepted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transport_events_status
        ON transport_events(status, accepted_at, event_id);
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_id TEXT UNIQUE,
        message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_handle TEXT NOT NULL,
        content TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','starting','processing')),
        last_notified_at INTEGER,
        processing_started_at INTEGER,
        read_marked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS deliveries_pending
        ON deliveries(status, created_at, delivery_id);
      CREATE TABLE IF NOT EXISTS observed_chats (
        chat_id TEXT PRIMARY KEY,
        last_owner_message_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbound_sends (
        session_key TEXT NOT NULL,
        send_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        PRIMARY KEY(session_key, send_id),
        UNIQUE(idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS relay_snapshot (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        through_sequence TEXT NOT NULL,
        reason TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
    `);
    if (existingSchema !== null && existingSchema < SCHEMA_VERSION) {
      transaction(this.#db, () => {
        this.#db.exec("DROP TABLE IF EXISTS permissions");
        this.#db.prepare("DELETE FROM metadata WHERE key LIKE 'active_origin:%'").run();
        this.#db.prepare(
          "UPDATE metadata SET value = ? WHERE key = 'schema_version'",
        ).run(String(SCHEMA_VERSION));
      });
    } else {
      this.#db.prepare(`
        INSERT INTO metadata(key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO NOTHING
      `).run(String(SCHEMA_VERSION));
    }
    this.#db.prepare(`
      INSERT INTO metadata(key, value) VALUES ('accepted_through', '0')
      ON CONFLICT(key) DO NOTHING
    `).run();
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // POSIX modes are best effort on Windows.
    }
  }

  close(): void {
    this.#db.close();
  }

  acceptedThrough(): string {
    const row = (
      this.#db.prepare("SELECT value FROM metadata WHERE key = 'accepted_through'").get()
    ) as Record<string, unknown> | undefined;
    const value = rowString(row, "value");
    if (value === null || !validSequence(value)) {
      throw new Error("durable Relay accepted_through is missing or corrupt");
    }
    return value;
  }

  acceptEvent(event: RelayWebhookEvent, sequence: string, now = Date.now()): "accepted" | "duplicate" {
    const next = asBigInt(sequence, "event sequence");
    const payload = JSON.stringify(event);
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    return transaction(this.#db, () => {
      const bySequence = this.#db.prepare(`
        SELECT event_id, payload_hash FROM transport_events WHERE sequence = ?
      `).get(sequence) as { event_id: string; payload_hash: string } | undefined;
      if (bySequence) {
        if (bySequence.event_id !== event.event_id || bySequence.payload_hash !== payloadHash) {
          throw new Error(`Relay sequence ${sequence} replayed with different event content`);
        }
        return "duplicate";
      }
      const byID = this.#db.prepare(`
        SELECT sequence, payload_hash FROM transport_events WHERE event_id = ?
      `).get(event.event_id) as { sequence: string; payload_hash: string } | undefined;
      if (byID) {
        if (byID.sequence !== sequence || byID.payload_hash !== payloadHash) {
          throw new Error(`Relay event ${event.event_id} appeared at a different sequence`);
        }
        return "duplicate";
      }
      const accepted = asBigInt(this.acceptedThrough(), "local accepted_through");
      if (next !== accepted + 1n) {
        throw new Error(
          next <= accepted
            ? `cannot verify replayed Relay sequence ${sequence}; durable event row is absent`
            : `local Relay cursor gap: accepted ${accepted}, received ${next}`,
        );
      }
      this.#db.prepare(`
        INSERT INTO transport_events(
          sequence, event_id, event_type, payload_hash, payload_json, status, accepted_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(sequence, event.event_id, event.event_type, payloadHash, payload, now);
      this.#db.prepare("UPDATE metadata SET value = ? WHERE key = 'accepted_through'").run(sequence);
      return "accepted";
    });
  }

  pendingIngress(limit = 100): StoredIngressEvent[] {
    const rows = this.#db.prepare(`
      SELECT sequence, payload_json FROM transport_events
      WHERE status = 'pending'
      ORDER BY accepted_at ASC, event_id ASC
      LIMIT ?
    `).all(limit) as unknown as Array<{ sequence: string; payload_json: string | null }>;
    return rows.map((row) => {
      if (row.payload_json === null) throw new Error(`pending Relay sequence ${row.sequence} lost its payload`);
      return {
        sequence: row.sequence,
        event: JSON.parse(row.payload_json) as RelayWebhookEvent,
      };
    });
  }

  completeIngress(eventId: string, status: "complete" | "blocked" = "complete"): void {
    const result = this.#db.prepare(`
      UPDATE transport_events SET status = ?, payload_json = NULL WHERE event_id = ? AND status = 'pending'
    `).run(status, eventId);
    if (Number(result.changes) === 0) {
      const row = (
        this.#db.prepare("SELECT status FROM transport_events WHERE event_id = ?").get(eventId)
      ) as { status: string } | undefined;
      if (!row) throw new Error(`unknown durable Relay event ${eventId}`);
    }
  }

  recordDelivery(delivery: DeliveryCandidate): void {
    transaction(this.#db, () => {
      const count = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending','starting')
      `).get() as { count: number };
      const existing = this.#db.prepare(`
        SELECT delivery_id, chat_id, message_id, content FROM deliveries
        WHERE delivery_id = ? OR message_id = ?
      `).get(delivery.deliveryId, delivery.messageId) as {
        delivery_id: string;
        chat_id: string;
        message_id: string;
        content: string;
      } | undefined;
      if (existing) {
        if (
          existing.delivery_id !== delivery.deliveryId
          || existing.chat_id !== delivery.chatId
          || existing.message_id !== delivery.messageId
          || existing.content !== delivery.content
        ) {
          throw new Error(`Relay Message ${delivery.messageId} conflicts with a durable delivery`);
        }
      } else {
        if (count.count >= MAX_PENDING_DELIVERIES) {
          throw new Error(
            `durable delivery backlog reached ${MAX_PENDING_DELIVERIES}; process existing Relay messages before accepting more`,
          );
        }
        this.#db.prepare(`
          INSERT INTO deliveries(
            delivery_id, event_id, message_id, chat_id, sender_id, sender_handle,
            content, meta_json, created_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(
          delivery.deliveryId,
          delivery.eventId,
          delivery.messageId,
          delivery.chatId,
          delivery.senderId,
          delivery.senderHandle,
          delivery.content,
          JSON.stringify(delivery.meta),
          delivery.createdAt,
        );
      }
      this.#db.prepare(`
        INSERT INTO observed_chats(chat_id, last_owner_message_at) VALUES (?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          last_owner_message_at = CASE
            WHEN excluded.last_owner_message_at > observed_chats.last_owner_message_at
            THEN excluded.last_owner_message_at ELSE observed_chats.last_owner_message_at END
      `).run(delivery.chatId, delivery.createdAt);
      if (delivery.eventId) {
        const result = this.#db.prepare(`
          UPDATE transport_events SET status = 'delivery', payload_json = NULL
          WHERE event_id = ? AND status = 'pending'
        `).run(delivery.eventId);
        if (Number(result.changes) === 0) {
          const row = this.#db.prepare("SELECT status FROM transport_events WHERE event_id = ?")
            .get(delivery.eventId) as { status: string } | undefined;
          if (!row || row.status !== "delivery") {
            throw new Error(`cannot bind delivery to Relay event ${delivery.eventId}`);
          }
        }
      }
    });
  }

  pendingDeliveries(retryBefore: number): StoredDelivery[] {
    const rows = this.#db.prepare(`
      SELECT * FROM deliveries
      WHERE status IN ('pending','starting')
        AND (last_notified_at IS NULL OR last_notified_at <= ?)
      ORDER BY created_at ASC, delivery_id ASC
    `).all(retryBefore) as unknown as DeliveryRow[];
    return rows.map(deliveryFromRow);
  }

  noteDeliveryNotified(deliveryId: string, now = Date.now()): void {
    this.#db.prepare(`
      UPDATE deliveries SET last_notified_at = ?
      WHERE delivery_id = ? AND status IN ('pending','starting')
    `).run(now, deliveryId);
  }

  beginDelivery(deliveryId: string, now = Date.now()): StoredDelivery | null {
    return transaction(this.#db, () => {
      const row = (
        this.#db.prepare("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId)
      ) as DeliveryRow | undefined;
      if (!row || row.status === "processing") return null;
      this.#db.prepare(`
        UPDATE deliveries SET status = 'starting', processing_started_at = COALESCE(processing_started_at, ?)
        WHERE delivery_id = ?
      `).run(now, deliveryId);
      return deliveryFromRow({
        ...row,
        status: "starting",
        processing_started_at: row.processing_started_at ?? now,
      });
    });
  }

  markDeliveryProcessing(
    deliveryId: string,
    now = Date.now(),
    activeTurnTtlMs = ACTIVE_TURN_TTL_MS,
  ): void {
    transaction(this.#db, () => {
      const result = this.#db.prepare(`
        UPDATE deliveries SET status = 'processing', read_marked_at = ?
        WHERE delivery_id = ? AND status = 'starting'
      `).run(now, deliveryId);
      if (Number(result.changes) !== 1) {
        throw new Error(`delivery ${deliveryId} is not waiting for its explicit Read receipt`);
      }
      this.#activateDeliveryOrigin(deliveryId, now, activeTurnTtlMs);
    });
  }

  delivery(deliveryId: string): StoredDelivery | null {
    const row = (
      this.#db.prepare("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId)
    ) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : null;
  }

  activateDeliveryOrigin(
    deliveryId: string,
    now = Date.now(),
    activeTurnTtlMs = ACTIVE_TURN_TTL_MS,
  ): TurnOrigin {
    return transaction(
      this.#db,
      () => this.#activateDeliveryOrigin(deliveryId, now, activeTurnTtlMs),
    );
  }

  #activeOriginKey(): string {
    return `active_origin:${this.#sessionKey}`;
  }

  #closedTurnKey(deliveryId: string): string {
    return `closed_turn:${this.#sessionKey}:${deliveryId}`;
  }

  #activeTurnLease(): ActiveTurnLease | null {
    const row = this.#db.prepare(
      "SELECT value FROM metadata WHERE key = ?",
    ).get(this.#activeOriginKey()) as Record<string, unknown> | undefined;
    const value = rowString(row, "value");
    if (value === null) return null;
    let lease: Partial<ActiveTurnLease>;
    try {
      lease = JSON.parse(value) as Partial<ActiveTurnLease>;
    } catch {
      throw new Error("durable active Relay turn lease is corrupt");
    }
    if (
      lease.version !== 1
      || typeof lease.deliveryId !== "string"
      || !Number.isSafeInteger(lease.activatedAt)
      || !Number.isSafeInteger(lease.expiresAt)
      || Number(lease.expiresAt) <= Number(lease.activatedAt)
    ) {
      throw new Error("durable active Relay turn lease is corrupt");
    }
    return lease as ActiveTurnLease;
  }

  #turnOriginForDelivery(deliveryId: string): TurnOrigin {
    const row = this.#db.prepare(`
      SELECT * FROM deliveries WHERE delivery_id = ? AND status = 'processing'
    `).get(deliveryId) as unknown as DeliveryRow | undefined;
    if (!row) throw new Error(`delivery ${deliveryId} has not started processing`);
    return {
      deliveryId: row.delivery_id,
      messageId: row.message_id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      senderHandle: row.sender_handle,
    };
  }

  #closeActiveTurn(
    outcome: TurnOutcome,
    now: number,
    expectedDeliveryId?: string,
  ): string | null {
    const lease = this.#activeTurnLease();
    if (!lease) return null;
    if (expectedDeliveryId !== undefined && lease.deliveryId !== expectedDeliveryId) {
      throw new Error(
        `delivery ${expectedDeliveryId} is not the active Relay turn`,
      );
    }
    this.#db.prepare("DELETE FROM metadata WHERE key = ?")
      .run(this.#activeOriginKey());
    this.#db.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(this.#closedTurnKey(lease.deliveryId), JSON.stringify({
      version: 1,
      outcome,
      closedAt: now,
    }));
    return lease.deliveryId;
  }

  #activateDeliveryOrigin(
    deliveryId: string,
    now: number,
    activeTurnTtlMs: number,
  ): TurnOrigin {
    if (!Number.isSafeInteger(activeTurnTtlMs) || activeTurnTtlMs <= 0) {
      throw new Error("active Relay turn TTL must be a positive integer");
    }
    const existing = this.#activeTurnLease();
    if (existing) {
      if (existing.expiresAt <= now) {
        this.#closeActiveTurn("expired", now, existing.deliveryId);
      } else if (existing.deliveryId === deliveryId) {
        return this.#turnOriginForDelivery(deliveryId);
      } else {
        this.#closeActiveTurn("superseded", now, existing.deliveryId);
      }
    }
    if (
      this.#db.prepare("SELECT 1 FROM metadata WHERE key = ?")
        .get(this.#closedTurnKey(deliveryId)) !== undefined
    ) {
      throw new Error(`delivery ${deliveryId} already has a closed Relay turn`);
    }
    const origin = this.#turnOriginForDelivery(deliveryId);
    const lease: ActiveTurnLease = {
      version: 1,
      deliveryId,
      activatedAt: now,
      expiresAt: now + activeTurnTtlMs,
    };
    if (!Number.isSafeInteger(lease.expiresAt)) {
      throw new Error("active Relay turn expiry exceeds the safe integer range");
    }
    this.#db.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(this.#activeOriginKey(), JSON.stringify(lease));
    return origin;
  }

  activeTurnOrigin(now = Date.now()): TurnOrigin | null {
    const lease = this.#activeTurnLease();
    if (!lease) return null;
    if (lease.expiresAt <= now) {
      this.expireActiveTurn(now);
      return null;
    }
    return this.#turnOriginForDelivery(lease.deliveryId);
  }

  expireActiveTurn(now = Date.now()): boolean {
    return transaction(this.#db, () => {
      const lease = this.#activeTurnLease();
      if (!lease || lease.expiresAt > now) return false;
      this.#closeActiveTurn("expired", now, lease.deliveryId);
      return true;
    });
  }

  clearActiveTurn(outcome: TurnOutcome = "failed", now = Date.now()): boolean {
    return transaction(
      this.#db,
      () => this.#closeActiveTurn(outcome, now) !== null,
    );
  }

  completeDeliveryTurn(
    deliveryId: string,
    outcome: Extract<TurnOutcome, "completed" | "failed">,
    now = Date.now(),
  ): "closed" | "already_closed" {
    return transaction(this.#db, () => {
      if (
        this.#db.prepare("SELECT 1 FROM metadata WHERE key = ?")
          .get(this.#closedTurnKey(deliveryId)) !== undefined
      ) return "already_closed";
      const closed = this.#closeActiveTurn(outcome, now, deliveryId);
      if (!closed) throw new Error("there is no active Relay turn to complete");
      return "closed";
    });
  }

  hasObservedChat(chatId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM observed_chats WHERE chat_id = ?").get(chatId) !== undefined;
  }

  mostRecentObservedChat(): string | null {
    const row = this.#db.prepare(`
      SELECT chat_id FROM observed_chats ORDER BY last_owner_message_at DESC, chat_id ASC LIMIT 1
    `).get() as { chat_id: string } | undefined;
    return row?.chat_id ?? null;
  }

  registerOutboundSend(params: {
    sendId: string;
    payloadHash: string;
    idempotencyKey: string;
    now?: number;
  }): OutboundRegistration {
    return transaction(this.#db, () => {
      const existing = this.existingOutboundSend(params);
      if (existing) {
        return existing;
      }
      this.#db.prepare(`
        INSERT INTO outbound_sends(
          session_key, send_id, payload_hash, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        this.#sessionKey,
        params.sendId,
        params.payloadHash,
        params.idempotencyKey,
        params.now ?? Date.now(),
      );
      return { idempotencyKey: params.idempotencyKey, confirmed: false };
    });
  }

  existingOutboundSend(params: {
    sendId: string;
    payloadHash: string;
    idempotencyKey: string;
  }): OutboundRegistration | null {
    const existing = this.#db.prepare(`
      SELECT payload_hash, idempotency_key, confirmed_at FROM outbound_sends
      WHERE session_key = ? AND send_id = ?
    `).get(this.#sessionKey, params.sendId) as {
      payload_hash: string;
      idempotency_key: string;
      confirmed_at: number | null;
    } | undefined;
    if (!existing) return null;
    if (
      existing.payload_hash !== params.payloadHash
      || existing.idempotency_key !== params.idempotencyKey
    ) {
      throw new Error(
        `send_id ${params.sendId} was already used for different Relay Message content`,
      );
    }
    return {
      idempotencyKey: existing.idempotency_key,
      confirmed: existing.confirmed_at !== null,
    };
  }

  confirmOutboundSend(sendId: string, now = Date.now()): void {
    const result = this.#db.prepare(`
      UPDATE outbound_sends SET confirmed_at = COALESCE(confirmed_at, ?)
      WHERE session_key = ? AND send_id = ?
    `).run(now, this.#sessionKey, sendId);
    if (Number(result.changes) !== 1) throw new Error(`unknown outbound send_id ${sendId}`);
  }

  replaceWithFullSync(
    snapshot: RelaySnapshot,
    deliveries: readonly DeliveryCandidate[],
  ): void {
    if (deliveries.length > MAX_UNREAD_FULL_SYNC_DELIVERIES) {
      throw new Error(
        `FULL sync found ${deliveries.length} unread allowed Messages; safe limit is ${MAX_UNREAD_FULL_SYNC_DELIVERIES}`,
      );
    }
    const through = asBigInt(snapshot.throughSequence, "FULL sync throughSequence");
    transaction(this.#db, () => {
      const local = asBigInt(this.acceptedThrough(), "local accepted_through");
      if (through < local) {
        throw new Error(
          `FULL sync checkpoint ${through} is behind durable local checkpoint ${local}`,
        );
      }
      this.#db.prepare(`
        INSERT INTO relay_snapshot(
          singleton, through_sequence, reason, snapshot_json, completed_at
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          through_sequence = excluded.through_sequence,
          reason = excluded.reason,
          snapshot_json = excluded.snapshot_json,
          completed_at = excluded.completed_at
      `).run(
        snapshot.throughSequence,
        snapshot.reason,
        JSON.stringify(snapshot),
        snapshot.completedAt,
      );
      for (const delivery of deliveries) {
        const existing = this.#db.prepare(`
          SELECT delivery_id, chat_id, content FROM deliveries WHERE message_id = ?
        `).get(delivery.messageId) as {
          delivery_id: string;
          chat_id: string;
          content: string;
        } | undefined;
        if (existing) {
          if (existing.chat_id !== delivery.chatId) {
            throw new Error(`FULL sync moved Relay Message ${delivery.messageId} between Chats`);
          }
          continue;
        }
        this.#db.prepare(`
          INSERT INTO deliveries(
            delivery_id, event_id, message_id, chat_id, sender_id, sender_handle,
            content, meta_json, created_at, status
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(
          delivery.deliveryId,
          delivery.messageId,
          delivery.chatId,
          delivery.senderId,
          delivery.senderHandle,
          delivery.content,
          JSON.stringify(delivery.meta),
          delivery.createdAt,
        );
        this.#db.prepare(`
          INSERT INTO observed_chats(chat_id, last_owner_message_at) VALUES (?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET
            last_owner_message_at = CASE
              WHEN excluded.last_owner_message_at > observed_chats.last_owner_message_at
              THEN excluded.last_owner_message_at ELSE observed_chats.last_owner_message_at END
        `).run(delivery.chatId, delivery.createdAt);
      }
      this.#db.prepare("UPDATE metadata SET value = ? WHERE key = 'accepted_through'")
        .run(snapshot.throughSequence);
      this.#db.prepare(`
        UPDATE transport_events SET status = 'complete', payload_json = NULL
        WHERE status = 'pending'
      `).run();
    });
  }

  readSnapshot(): RelaySnapshot | null {
    const row = (
      this.#db.prepare("SELECT snapshot_json FROM relay_snapshot WHERE singleton = 1").get()
    ) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as RelaySnapshot : null;
  }
}
