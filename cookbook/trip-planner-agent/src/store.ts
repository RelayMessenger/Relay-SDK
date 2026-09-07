import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  RelayWebhookEvent,
  WebSocketFullSyncContext,
} from "@relaymessenger/sdk";

import type { ThreadMessage, TripPlan } from "./plan.js";
import type { RememberedMessage } from "./snapshot.js";
import type { TripMemory } from "./processor.js";

export interface AcceptedEvent {
  attempts: number;
  event: RelayWebhookEvent;
  eventId: string;
}

/**
 * The durable inbox and the group's memory in one owner-only SQLite file.
 * `event_id` is the deduplication key: a replayed event is accepted once.
 *
 * The webhook-receiver and websocket-agent recipes carry a hardened
 * `openat`-based path check for the same file. Use theirs when the process
 * runs somewhere another user can write.
 */
export class TripStore implements TripMemory {
  readonly #database: DatabaseSync;

  constructor(filename: string, accountScope: string) {
    if (!accountScope) throw new Error("Relay account scope is required");
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { mode: 0o700, recursive: true });
    }
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY,
        sequence TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'processing', 'done')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        accepted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        remembered_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        chat_id TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        plan_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_ready
        ON inbox (state, available_at, lease_until, accepted_at);
      CREATE INDEX IF NOT EXISTS thread_chat
        ON thread (chat_id, remembered_at, message_id);
    `);
    if (filename !== ":memory:") chmodSync(filename, 0o600);

    const row = this.#database.prepare(`
      SELECT value FROM metadata WHERE key = 'account_scope'
    `).get() as { value: string } | undefined;
    if (row && row.value !== accountScope) {
      this.#database.close();
      throw new Error("This state belongs to a different agent or API origin");
    }
    this.#database.prepare(`
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('account_scope', ?)
    `).run(accountScope);
  }

  /** Runs inside the socket callback, before the SDK acknowledges. */
  accept(event: RelayWebhookEvent, sequence: string, now = Date.now()): boolean {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO inbox (event_id, sequence, envelope_json, accepted_at)
      VALUES (?, ?, ?, ?)
    `).run(event.event_id, sequence, JSON.stringify(event), now);
    return result.changes === 1;
  }

  claim(now = Date.now(), leaseMs = 120_000): AcceptedEvent | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`
        SELECT event_id, envelope_json, attempts
        FROM inbox
        WHERE (state = 'pending' AND available_at <= ?)
          OR (state = 'processing' AND lease_until <= ?)
        ORDER BY accepted_at
        LIMIT 1
      `).get(now, now) as
        | { attempts: number; envelope_json: string; event_id: string }
        | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return null;
      }
      this.#database.prepare(`
        UPDATE inbox
        SET state = 'processing', attempts = attempts + 1, lease_until = ?,
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
      UPDATE inbox SET state = 'done', lease_until = NULL, last_error = NULL
      WHERE event_id = ?
    `).run(eventId);
  }

  retry(eventId: string, error: unknown, availableAt: number): void {
    this.#database.prepare(`
      UPDATE inbox
      SET state = 'pending', available_at = ?, lease_until = NULL, last_error = ?
      WHERE event_id = ?
    `).run(
      availableAt,
      error instanceof Error ? error.message : String(error),
      eventId,
    );
  }

  nextAvailableAt(now = Date.now()): number | null {
    const row = this.#database.prepare(`
      SELECT MIN(CASE WHEN state = 'pending' THEN available_at ELSE lease_until END)
        AS next_at
      FROM inbox
      WHERE state IN ('pending', 'processing')
    `).get() as { next_at: number | null };
    return row.next_at === null ? null : Math.max(now, row.next_at);
  }

  remember(chatId: string, messageId: string, message: ThreadMessage): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO thread
        (message_id, chat_id, author, text, remembered_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(messageId, chatId, message.author, message.text, Date.now());
  }

  thread(chatId: string): ThreadMessage[] {
    const rows = this.#database.prepare(`
      SELECT author, text FROM thread
      WHERE chat_id = ?
      ORDER BY remembered_at, message_id
    `).all(chatId) as Array<{ author: string; text: string }>;
    return rows.map(({ author, text }) => ({ author, text }));
  }

  currentPlan(chatId: string): TripPlan | null {
    const row = this.#database.prepare(`
      SELECT plan_json FROM plans WHERE chat_id = ?
    `).get(chatId) as { plan_json: string } | undefined;
    return row ? JSON.parse(row.plan_json) as TripPlan : null;
  }

  plannedTurn(eventId: string): TripPlan | null {
    const row = this.#database.prepare(`
      SELECT plan_json FROM turns WHERE event_id = ?
    `).get(eventId) as { plan_json: string } | undefined;
    return row ? JSON.parse(row.plan_json) as TripPlan : null;
  }

  savePlannedTurn(eventId: string, chatId: string, plan: TripPlan): void {
    const json = JSON.stringify(plan);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT OR IGNORE INTO turns (event_id, chat_id, plan_json) VALUES (?, ?, ?)
      `).run(eventId, chatId, json);
      this.#database.prepare(`
        INSERT INTO plans (chat_id, plan_json) VALUES (?, ?)
        ON CONFLICT (chat_id) DO UPDATE SET plan_json = excluded.plan_json
      `).run(chatId, json);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /** FULL sync: replace every remembered thread in one transaction. */
  replaceThreads(
    remembered: RememberedMessage[],
    context: WebSocketFullSyncContext,
  ): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec("DELETE FROM thread");
      const insert = this.#database.prepare(`
        INSERT INTO thread (message_id, chat_id, author, text, remembered_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of remembered) {
        insert.run(row.messageId, row.chatId, row.author, row.text, row.rememberedAt);
      }
      this.#database.prepare(`
        INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run("full_sync_through", context.throughSequence);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  metadata(key: string): string | null {
    const row = this.#database.prepare(`
      SELECT value FROM metadata WHERE key = ?
    `).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.#database.close();
  }
}
