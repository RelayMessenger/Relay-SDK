import { DatabaseSync } from "node:sqlite";

import type { RelayWebhookEvent } from "@relaymessenger/sdk";

import { preparePrivateSqlitePath } from "./private-sqlite.js";

export interface AcceptedEvent {
  attempts: number;
  event: RelayWebhookEvent;
  eventId: string;
}

export class DurableInbox {
  readonly #database: DatabaseSync;

  constructor(filename: string, accountScope: string) {
    if (!accountScope) throw new Error("Relay account scope is required");
    const memory = filename === ":memory:";
    const path = memory
      ? filename
      : preparePrivateSqlitePath(filename, "Relay inbox");
    this.#database = new DatabaseSync(path);

    const tables = this.#database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>;
    const hasMetadata = tables.some(({ name }) => name === "metadata");
    if (tables.length > 0 && !hasMetadata) {
      this.#database.close();
      throw new Error("Existing Relay inbox has no account binding");
    }
    if (hasMetadata) {
      const row = this.#database.prepare(`
        SELECT value FROM metadata WHERE key = 'account_scope'
      `).get() as { value: string } | undefined;
      if (!row || row.value !== accountScope) {
        this.#database.close();
        throw new Error("Relay inbox belongs to a different account or API origin");
      }
    }

    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'processing', 'done')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        accepted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_ready
        ON inbox (state, available_at, lease_until, accepted_at);
    `);
    this.#database.prepare(`
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('account_scope', ?)
    `).run(accountScope);
  }

  accept(event: RelayWebhookEvent, now = Date.now()): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(`
        INSERT OR IGNORE INTO inbox (
          event_id,
          envelope_json,
          accepted_at
        ) VALUES (?, ?, ?)
      `).run(event.event_id, JSON.stringify(event), now);
      this.#database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claim(now = Date.now(), leaseMs = 60_000): AcceptedEvent | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`
        SELECT event_id, envelope_json, attempts
        FROM inbox
        WHERE
          (state = 'pending' AND available_at <= ?)
          OR (state = 'processing' AND lease_until <= ?)
        ORDER BY accepted_at
        LIMIT 1
      `).get(now, now) as
        | {
          attempts: number;
          envelope_json: string;
          event_id: string;
        }
        | undefined;

      if (!row) {
        this.#database.exec("COMMIT");
        return null;
      }

      this.#database.prepare(`
        UPDATE inbox
        SET
          state = 'processing',
          attempts = attempts + 1,
          lease_until = ?,
          last_error = NULL
        WHERE event_id = ?
      `).run(now + leaseMs, row.event_id);
      this.#database.exec("COMMIT");
      return {
        attempts: row.attempts + 1,
        event: JSON.parse(row.envelope_json) as RelayWebhookEvent,
        eventId: row.event_id,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(eventId: string): void {
    this.#database.prepare(`
      UPDATE inbox
      SET state = 'done', lease_until = NULL, last_error = NULL
      WHERE event_id = ?
    `).run(eventId);
  }

  retry(
    eventId: string,
    error: unknown,
    availableAt: number,
  ): void {
    this.#database.prepare(`
      UPDATE inbox
      SET
        state = 'pending',
        available_at = ?,
        lease_until = NULL,
        last_error = ?
      WHERE event_id = ?
    `).run(
      availableAt,
      error instanceof Error ? error.message : String(error),
      eventId,
    );
  }

  nextAvailableAt(now = Date.now()): number | null {
    const row = this.#database.prepare(`
      SELECT MIN(
        CASE
          WHEN state = 'pending' THEN available_at
          ELSE lease_until
        END
      ) AS next_at
      FROM inbox
      WHERE state IN ('pending', 'processing')
    `).get() as { next_at: number | null };
    return row.next_at === null ? null : Math.max(now, row.next_at);
  }

  state(eventId: string): string | null {
    const row = this.#database.prepare(`
      SELECT state FROM inbox WHERE event_id = ?
    `).get(eventId) as { state: string } | undefined;
    return row?.state ?? null;
  }

  close(): void {
    this.#database.close();
  }
}
