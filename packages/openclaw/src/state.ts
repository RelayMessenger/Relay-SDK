import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  RelayIngressPayload,
  RelaySnapshot,
} from "./types.js";

type QueueStatus = "pending" | "claimed" | "completed" | "failed";

type QueueRow = {
  event_id: string;
  status: QueueStatus;
  payload_json: string;
  metadata_json: string | null;
  lane_key: string | null;
  received_at: number;
  updated_at: number;
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  claim_token: string | null;
  claim_owner: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  completed_metadata_json: string | null;
  failed_at: number | null;
  failed_reason: string | null;
};

type RelayQueue = ChannelIngressQueue<RelayIngressPayload>;

const databases = new Map<string, DatabaseSync>();

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows does not implement POSIX modes completely.
  }
}

function openDatabase(path: string): DatabaseSync {
  const existing = databases.get(path);
  if (existing) return existing;

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_ingress (
      event_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','failed')),
      payload_json TEXT NOT NULL,
      metadata_json TEXT,
      lane_key TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT,
      claim_token TEXT,
      claim_owner TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      completed_metadata_json TEXT,
      failed_at INTEGER,
      failed_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS relay_ingress_pending_order
      ON relay_ingress(status, received_at, event_id);
    CREATE INDEX IF NOT EXISTS relay_ingress_claimed_order
      ON relay_ingress(status, claimed_at, event_id);
    CREATE TABLE IF NOT EXISTS relay_snapshot (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes completely.
  }
  databases.set(path, db);
  return db;
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the operation error.
    }
    throw error;
  }
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as T;
}

function queueRecord(row: QueueRow, accountId: string): ChannelIngressQueueRecord<RelayIngressPayload> {
  return {
    id: row.event_id,
    channelId: "relay",
    accountId,
    queueName: JSON.stringify(["relay", accountId]),
    payload: parseJson<RelayIngressPayload>(row.payload_json) ?? {
      version: 1,
      rawEvent: "",
    },
    ...(row.metadata_json === null
      ? {}
      : { metadata: parseJson<unknown>(row.metadata_json) }),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    attempts: row.attempts,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function claimedRecord(
  row: QueueRow,
  accountId: string,
): ChannelIngressQueueClaim<RelayIngressPayload> | null {
  if (
    row.status !== "claimed" ||
    !row.claim_token ||
    !row.claim_owner ||
    row.claimed_at === null
  ) {
    return null;
  }
  return {
    ...queueRecord(row, accountId),
    claim: {
      token: row.claim_token,
      ownerId: row.claim_owner,
      claimedAt: row.claimed_at,
    },
  };
}

function completedRecord(row: QueueRow, accountId: string) {
  return {
    id: row.event_id,
    channelId: "relay",
    accountId,
    queueName: JSON.stringify(["relay", accountId]),
    completedAt: row.completed_at ?? row.updated_at,
    ...(row.completed_metadata_json === null
      ? {}
      : { metadata: parseJson<unknown>(row.completed_metadata_json) }),
  };
}

function failedRecord(row: QueueRow, accountId: string) {
  return {
    id: row.event_id,
    channelId: "relay",
    accountId,
    queueName: JSON.stringify(["relay", accountId]),
    failedAt: row.failed_at ?? row.updated_at,
    reason: row.failed_reason ?? "failed",
    ...(row.last_error === null ? {} : { message: row.last_error }),
  };
}

function selectRow(db: DatabaseSync, id: string): QueueRow | undefined {
  return db
    .prepare("SELECT * FROM relay_ingress WHERE event_id = ?")
    .get(id) as QueueRow | undefined;
}

function claimToken(
  value: string | ChannelIngressQueueClaimRef,
): string | null {
  return typeof value === "string" ? null : value.claim.token;
}

function entryId(value: string | { id: string }): string {
  const id = (typeof value === "string" ? value : value.id).trim();
  if (!id) throw new Error("relay: ingress event id cannot be empty");
  return id;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function createRelayIngressQueue(
  db: DatabaseSync,
  accountId: string,
  now: () => number,
): RelayQueue {
  const queue: RelayQueue = {
    enqueue: async (id, payload, options) =>
      transaction(db, () => {
        const eventId = entryId(id);
        const receivedAt = options?.receivedAt ?? now();
        const updatedAt = now();
        const inserted = db.prepare(`
          INSERT INTO relay_ingress (
            event_id, status, payload_json, metadata_json, lane_key,
            received_at, updated_at, attempts
          ) VALUES (?, 'pending', ?, ?, ?, ?, ?, 0)
          ON CONFLICT(event_id) DO NOTHING
        `).run(
          eventId,
          JSON.stringify(payload),
          options?.metadata === undefined ? null : JSON.stringify(options.metadata),
          options?.laneKey ?? null,
          receivedAt,
          updatedAt,
        );
        const row = selectRow(db, eventId);
        if (!row) throw new Error(`relay: failed to read ingress event ${eventId}`);
        if (Number(inserted.changes) > 0) {
          return {
            kind: "accepted" as const,
            duplicate: false as const,
            record: queueRecord(row, accountId),
          };
        }
        if (row.status === "claimed") {
          const record = claimedRecord(row, accountId);
          if (!record) throw new Error(`relay: corrupt claimed ingress event ${eventId}`);
          return { kind: "claimed" as const, duplicate: true as const, record };
        }
        if (row.status === "completed") {
          return {
            kind: "completed" as const,
            duplicate: true as const,
            record: completedRecord(row, accountId),
          };
        }
        if (row.status === "failed") {
          return {
            kind: "failed" as const,
            duplicate: true as const,
            record: failedRecord(row, accountId),
          };
        }
        return {
          kind: "pending" as const,
          duplicate: true as const,
          record: queueRecord(row, accountId),
        };
      }),

    listPending: async (options) => {
      const order = options?.orderBy === "id"
        ? "event_id ASC"
        : "received_at ASC, event_id ASC";
      const limit = options?.limit === "all"
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(options?.limit ?? 100));
      const rows = db
        .prepare(`SELECT * FROM relay_ingress WHERE status = 'pending' ORDER BY ${order} LIMIT ?`)
        .all(limit) as unknown as QueueRow[];
      return rows.map((row) => queueRecord(row, accountId));
    },

    listClaims: async () => {
      const rows = db
        .prepare(`
          SELECT * FROM relay_ingress
          WHERE status = 'claimed'
          ORDER BY claimed_at ASC, received_at ASC, event_id ASC
        `)
        .all() as unknown as QueueRow[];
      return rows
        .map((row) => claimedRecord(row, accountId))
        .filter((row): row is ChannelIngressQueueClaim<RelayIngressPayload> => row !== null);
    },

    claimNext: async (options) => {
      if (options?.staleMs !== undefined) {
        await queue.recoverStaleClaims({ staleMs: options.staleMs });
      }
      const blocked = new Set(
        [...(options?.blockedLaneKeys ?? [])]
          .map((value) => value.trim())
          .filter(Boolean),
      );
      const candidateIds =
        options?.candidateIds === undefined
          ? undefined
          : new Set(
              [...options.candidateIds]
                .map((value) => value.trim())
                .filter(Boolean),
            );
      if (candidateIds?.size === 0) return null;

      return transaction(db, () => {
        const order = options?.orderBy === "id"
          ? "event_id ASC"
          : "received_at ASC, event_id ASC";
        const scanLimit = Math.max(1, Math.floor(options?.scanLimit ?? 100));
        const rows = db
          .prepare(`SELECT * FROM relay_ingress WHERE status = 'pending' ORDER BY ${order} LIMIT ?`)
          .all(scanLimit) as unknown as QueueRow[];
        let selected: { row: QueueRow; laneKey?: string } | undefined;
        for (const row of rows) {
          if (candidateIds && !candidateIds.has(row.event_id)) continue;
          const record = queueRecord(row, accountId);
          let laneKey = record.laneKey;
          const derived = options?.deriveLaneKey?.(record);
          if (!laneKey) {
            laneKey = derived;
          } else if (
            derived &&
            derived !== laneKey &&
            options?.reconcileStoredLaneKey?.(record, laneKey, derived)
          ) {
            laneKey = derived;
          }
          if (laneKey && blocked.has(laneKey)) continue;
          selected = { row, ...(laneKey ? { laneKey } : {}) };
          break;
        }
        if (!selected) return null;

        const claimedAt = now();
        const token = randomUUID();
        const ownerId = options?.ownerId?.trim() || String(process.pid);
        const result = db.prepare(`
          UPDATE relay_ingress
          SET status = 'claimed', claim_token = ?, claim_owner = ?,
              claimed_at = ?, updated_at = ?, lane_key = COALESCE(?, lane_key)
          WHERE event_id = ? AND status = 'pending'
        `).run(
          token,
          ownerId,
          claimedAt,
          claimedAt,
          selected.laneKey ?? null,
          selected.row.event_id,
        );
        if (Number(result.changes) === 0) return null;
        const row = selectRow(db, selected.row.event_id);
        return row ? claimedRecord(row, accountId) : null;
      });
    },

    claim: async (id, options) =>
      transaction(db, () => {
        const eventId = entryId(id);
        const claimedAt = now();
        const token = randomUUID();
        const ownerId = options?.ownerId?.trim() || String(process.pid);
        const result = db.prepare(`
          UPDATE relay_ingress
          SET status = 'claimed', claim_token = ?, claim_owner = ?,
              claimed_at = ?, updated_at = ?
          WHERE event_id = ? AND status = 'pending'
        `).run(token, ownerId, claimedAt, claimedAt, eventId);
        if (Number(result.changes) === 0) return null;
        const row = selectRow(db, eventId);
        return row ? claimedRecord(row, accountId) : null;
      }),

    refreshClaim: async (claim, options) => {
      const refreshedAt = options?.refreshedAt ?? now();
      const result = db.prepare(`
        UPDATE relay_ingress
        SET claimed_at = ?, updated_at = ?
        WHERE event_id = ? AND status = 'claimed' AND claim_token = ?
      `).run(refreshedAt, refreshedAt, entryId(claim), claim.claim.token);
      return Number(result.changes) > 0;
    },

    complete: async (idOrClaim, options) =>
      transaction(db, () => {
        const id = entryId(idOrClaim);
        const token = claimToken(idOrClaim);
        const completedAt = options?.completedAt ?? now();
        const where = token === null
          ? "event_id = ? AND status = 'pending'"
          : "event_id = ? AND status = 'claimed' AND claim_token = ?";
        const values = token === null ? [id] : [id, token];
        const result = db.prepare(`
          UPDATE relay_ingress
          SET status = 'completed', payload_json = 'null', metadata_json = NULL,
              claim_token = NULL, claim_owner = NULL, claimed_at = NULL,
              completed_at = ?, completed_metadata_json = ?,
              last_attempt_at = NULL, last_error = NULL, updated_at = ?
          WHERE ${where}
        `).run(
          completedAt,
          options?.metadata === undefined ? null : JSON.stringify(options.metadata),
          completedAt,
          ...values,
        );
        if (Number(result.changes) > 0) return true;
        if (token !== null) return false;
        const inserted = db.prepare(`
          INSERT INTO relay_ingress (
            event_id, status, payload_json, received_at, updated_at,
            attempts, completed_at, completed_metadata_json
          ) VALUES (?, 'completed', 'null', ?, ?, 0, ?, ?)
          ON CONFLICT(event_id) DO NOTHING
        `).run(
          id,
          completedAt,
          completedAt,
          completedAt,
          options?.metadata === undefined ? null : JSON.stringify(options.metadata),
        );
        return Number(inserted.changes) > 0;
      }),

    release: async (idOrClaim, options) => {
      const id = entryId(idOrClaim);
      const token = claimToken(idOrClaim);
      const releasedAt = options?.releasedAt ?? now();
      const where = token === null
        ? "event_id = ? AND status = 'pending'"
        : "event_id = ? AND status = 'claimed' AND claim_token = ?";
      const values = token === null ? [id] : [id, token];
      const result = db.prepare(`
        UPDATE relay_ingress
        SET status = 'pending', claim_token = NULL, claim_owner = NULL,
            claimed_at = NULL,
            attempts = attempts + ?,
            last_attempt_at = CASE WHEN ? = 1 THEN ? ELSE last_attempt_at END,
            last_error = COALESCE(?, last_error), updated_at = ?
        WHERE ${where}
      `).run(
        options?.recordAttempt === false ? 0 : 1,
        options?.recordAttempt === false ? 0 : 1,
        releasedAt,
        options?.lastError ?? null,
        releasedAt,
        ...values,
      );
      return Number(result.changes) > 0;
    },

    fail: async (idOrClaim, options) => {
      const id = entryId(idOrClaim);
      const token = claimToken(idOrClaim);
      const failedAt = options.failedAt ?? now();
      const where = token === null
        ? "event_id = ? AND status = 'pending'"
        : "event_id = ? AND status = 'claimed' AND claim_token = ?";
      const values = token === null ? [id] : [id, token];
      const result = db.prepare(`
        UPDATE relay_ingress
        SET status = 'failed', claim_token = NULL, claim_owner = NULL,
            claimed_at = NULL, failed_at = ?, failed_reason = ?,
            last_error = ?, updated_at = ?
        WHERE ${where}
      `).run(
        failedAt,
        options.reason,
        options.message ?? null,
        failedAt,
        ...values,
      );
      return Number(result.changes) > 0;
    },

    delete: async (idOrRecord) => {
      const id = entryId(idOrRecord);
      const token =
        typeof idOrRecord === "string" || !("claim" in idOrRecord)
          ? null
          : idOrRecord.claim.token;
      const result = token === null
        ? db.prepare("DELETE FROM relay_ingress WHERE event_id = ?").run(id)
        : db
            .prepare(`
              DELETE FROM relay_ingress
              WHERE event_id = ? AND status = 'claimed' AND claim_token = ?
            `)
            .run(id, token);
      return Number(result.changes) > 0;
    },

    recoverStaleClaims: async (options) => {
      const current = options?.now ?? now();
      const staleMs = Math.max(0, options?.staleMs ?? 5 * 60_000);
      const cutoff = current - staleMs;
      const claims = await queue.listClaims();
      let recovered = 0;
      for (const claim of claims) {
        if (claim.claim.claimedAt > cutoff) continue;
        if (options?.shouldRecover && !(await options.shouldRecover(claim))) continue;
        const result = db.prepare(`
          UPDATE relay_ingress
          SET status = 'pending', claim_token = NULL, claim_owner = NULL,
              claimed_at = NULL, attempts = attempts + 1,
              last_attempt_at = ?, updated_at = ?
          WHERE event_id = ? AND status = 'claimed' AND claim_token = ?
            AND claimed_at <= ?
        `).run(current, current, claim.id, claim.claim.token, cutoff);
        recovered += Number(result.changes);
      }
      return recovered;
    },

    prune: async (options) =>
      transaction(db, () => {
        const current = options?.now ?? now();
        const protectedIds = new Set(options?.protectIds ?? []);
        let removed = 0;
        for (const [status, ttl, maxEntries] of [
          ["pending", options?.pendingTtlMs, options?.pendingMaxEntries],
          ["completed", options?.completedTtlMs, options?.completedMaxEntries],
          ["failed", options?.failedTtlMs, options?.failedMaxEntries],
        ] as const) {
          const rows = db
            .prepare(`
              SELECT event_id, updated_at FROM relay_ingress
              WHERE status = ? ORDER BY updated_at ASC, event_id ASC
            `)
            .all(status) as unknown as Array<{ event_id: string; updated_at: number }>;
          const expired = ttl === undefined
            ? []
            : rows.filter((row) => row.updated_at <= current - ttl);
          const live = rows.filter((row) => !expired.includes(row));
          const overflow =
            maxEntries === undefined
              ? []
              : live.slice(0, Math.max(0, live.length - Math.max(0, maxEntries)));
          const ids = [...new Set([...expired, ...overflow].map((row) => row.event_id))]
            .filter((id) => !protectedIds.has(id));
          if (ids.length === 0) continue;
          const result = db
            .prepare(`
              DELETE FROM relay_ingress
              WHERE status = ? AND event_id IN (${placeholders(ids)})
            `)
            .run(status, ...ids);
          removed += Number(result.changes);
        }
        return removed;
      }),
  };
  return queue;
}

export type RelayStateStore = {
  readonly path: string;
  readonly ingressQueue: RelayQueue;
  replaceSnapshot(snapshot: RelaySnapshot): Promise<void>;
  readSnapshot(): Promise<RelaySnapshot | undefined>;
};

export function openRelayStateStore(params: {
  stateDir: string;
  accountId: string;
  now?: () => number;
}): RelayStateStore {
  const root = join(params.stateDir, "relay");
  ensurePrivateDirectory(root);
  const accountHash = createHash("sha256")
    .update(params.accountId)
    .digest("hex")
    .slice(0, 24);
  const path = join(root, `account-${accountHash}.sqlite`);
  const db = openDatabase(path);
  const now = params.now ?? Date.now;
  return {
    path,
    ingressQueue: createRelayIngressQueue(db, params.accountId, now),
    replaceSnapshot: async (snapshot) => {
      transaction(db, () => {
        db.prepare(`
          INSERT INTO relay_snapshot(singleton, snapshot_json, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE
          SET snapshot_json = excluded.snapshot_json,
              updated_at = excluded.updated_at
        `).run(JSON.stringify(snapshot), now());
      });
    },
    readSnapshot: async () => {
      const row = db
        .prepare("SELECT snapshot_json FROM relay_snapshot WHERE singleton = 1")
        .get() as { snapshot_json: string } | undefined;
      return row ? parseJson<RelaySnapshot>(row.snapshot_json) : undefined;
    },
  };
}
