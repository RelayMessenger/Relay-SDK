import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";

export function inboxDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const home = configured === "~" || configured?.startsWith("~/")
    ? join(homedir(), configured.slice(1))
    : configured || join(homedir(), ".pi", "agent");
  return join(home, "relay", "channel-inbox");
}

/** Private to the channel: an ACK transfers ownership here, not to Pi's memory. */
export class ChannelInbox {
  readonly #lock: DatabaseSync;
  readonly #db: DatabaseSync;

  constructor(directory: string, origin: string, agentId: string) {
    const account = createHash("sha256").update(JSON.stringify([origin, agentId])).digest("hex");
    const path = join(directory, account);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    // A separate SQLite transaction holds the process-lifetime writer lock.
    // The OS releases it on a crash; no PID file or stale-lock deletion race.
    this.#lock = new DatabaseSync(join(path, "writer.sqlite"));
    let db: DatabaseSync | undefined;
    try {
      chmodSync(join(path, "writer.sqlite"), 0o600);
      this.#lock.exec("BEGIN EXCLUSIVE");
      db = new DatabaseSync(join(path, "inbox.sqlite"));
      chmodSync(join(path, "inbox.sqlite"), 0o600);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS events (
          ordinal INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          event_json TEXT NOT NULL,
          reply_id TEXT,
          done INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS replies (
          event_id TEXT PRIMARY KEY,
          answer TEXT NOT NULL
        );
      `);
      this.#db = db;
    } catch (error) {
      db?.close();
      this.#lock.close();
      throw error;
    }
  }

  /** SQLite's FULL-synchronous commit completes before the handler can ACK. */
  accept(event: RelayWebhookEvent): boolean {
    return this.#db.prepare(
      "INSERT INTO events (event_id, event_json) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING",
    ).run(event.event_id, JSON.stringify(event)).changes === 1;
  }

  pending(): RelayWebhookEvent[] {
    return this.#db.prepare(`
      SELECT event_json FROM events
      WHERE done = 0 AND (reply_id IS NULL OR reply_id = event_id)
      ORDER BY ordinal
    `).all().map((row) => JSON.parse(String(row.event_json)) as RelayWebhookEvent);
  }

  answer(eventId: string): string | undefined {
    const row = this.#db.prepare("SELECT answer FROM replies WHERE event_id = ?").get(eventId);
    return row ? String(row.answer) : undefined;
  }

  /** Freeze both the reply and the events it finishes before any network send. */
  prepareReply(eventId: string, answer: string, consumed: readonly string[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO replies (event_id, answer) VALUES (?, ?)").run(eventId, answer);
      const link = this.#db.prepare("UPDATE events SET reply_id = ? WHERE event_id = ?");
      for (const id of consumed) link.run(eventId, id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(eventId: string): void {
    this.#db.prepare("UPDATE events SET done = 1 WHERE event_id = ? OR reply_id = ?")
      .run(eventId, eventId);
  }

  close(): void {
    try { this.#db.close(); } finally { this.#lock.close(); }
  }
}
