import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Media, ResponseItem } from "./xai.js";

/**
 * Durable progress, so a redelivered event resumes where it stopped: each
 * chat's Grok input items, each event's state, every picture or video
 * already uploaded, and every Message already sent. Relay delivers an event
 * again when its handler fails or the connection drops; without this, the
 * agent would add the person's words twice, ask Grok again, and pay for the
 * same picture twice.
 */
export class ProgressStore {
  readonly #db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { mode: 0o700, recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS items (
        chat_id TEXT NOT NULL, seq INTEGER NOT NULL, item TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq));
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0, message_id TEXT,
        deliveries INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS events_message ON events (message_id);
      CREATE TABLE IF NOT EXISTS videos (
        key TEXT PRIMARY KEY, request_id TEXT NOT NULL, deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS steps (
        event_id TEXT NOT NULL, idx INTEGER NOT NULL, output TEXT NOT NULL,
        PRIMARY KEY (event_id, idx));
      CREATE TABLE IF NOT EXISTS media (
        key TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT NOT NULL, filename TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (
        key TEXT PRIMARY KEY, attachment_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (
        key TEXT PRIMARY KEY, message_id TEXT NOT NULL);
    `);
  }

  /**
   * Starts an event once: its first item joins the chat only on first
   * delivery. A Message already answered under another event (a FULL-sync
   * recovery, then its late delivery) starts nothing; the result says so.
   */
  begin(eventId: string, chatId: string, first: ResponseItem, messageId?: string): boolean {
    let started = false;
    this.#transaction(() => {
      const known = this.#db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eventId);
      if (known) {
        started = true;
        return;
      }
      if (messageId && this.#db.prepare("SELECT 1 FROM events WHERE message_id = ?").get(messageId)) return;
      this.#db.prepare("INSERT INTO events (event_id, chat_id, message_id) VALUES (?, ?, ?)")
        .run(eventId, chatId, messageId ?? null);
      this.#append(chatId, [first]);
      started = true;
    });
    return started;
  }

  /** Counts one more delivery of an event and returns the count. */
  delivered(eventId: string): number {
    this.#db.prepare("UPDATE events SET deliveries = deliveries + 1 WHERE event_id = ?").run(eventId);
    return (this.#db.prepare("SELECT deliveries FROM events WHERE event_id = ?").get(eventId) as { deliveries: number }).deliveries;
  }

  /** Marks an event failed: it is done, and Relay may forget it. */
  fail(eventId: string): void {
    this.#db.prepare("UPDATE events SET failed = 1 WHERE event_id = ?").run(eventId);
    this.finish(eventId);
  }

  failed(eventId: string): boolean {
    return (this.#db.prepare("SELECT failed FROM events WHERE event_id = ?").get(eventId) as { failed: number } | undefined)
      ?.failed === 1;
  }

  /** Whether an event has already taken this Message. */
  hasMessage(messageId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM events WHERE message_id = ?").get(messageId));
  }

  /** A video request already sent to Grok Imagine, so polling resumes instead of paying again. */
  video(key: string): { requestId: string; deadline: number } | undefined {
    const row = this.#db.prepare("SELECT request_id, deadline FROM videos WHERE key = ?").get(key) as
      { request_id: string; deadline: number } | undefined;
    return row && { requestId: row.request_id, deadline: row.deadline };
  }

  saveVideo(key: string, requestId: string, deadline: number): void {
    this.#db.prepare("INSERT OR REPLACE INTO videos (key, request_id, deadline) VALUES (?, ?, ?)")
      .run(key, requestId, deadline);
  }

  event(eventId: string): { steps: number; done: boolean } | undefined {
    const row = this.#db.prepare("SELECT steps, done FROM events WHERE event_id = ?").get(eventId) as
      { steps: number; done: number } | undefined;
    return row && { steps: row.steps, done: row.done === 1 };
  }

  items(chatId: string): ResponseItem[] {
    return (this.#db.prepare("SELECT item FROM items WHERE chat_id = ? ORDER BY seq").all(chatId) as { item: string }[])
      .map((row) => JSON.parse(row.item) as ResponseItem);
  }

  /** Records one finished Grok step: its output joins the chat and the event's steps. */
  step(eventId: string, chatId: string, output: ResponseItem[]): void {
    this.#transaction(() => {
      this.#append(chatId, output);
      const { next } = this.#db.prepare("SELECT COUNT(*) AS next FROM steps WHERE event_id = ?").get(eventId) as
        { next: number };
      this.#db.prepare("INSERT INTO steps (event_id, idx, output) VALUES (?, ?, ?)")
        .run(eventId, next, JSON.stringify(output));
      this.#db.prepare("UPDATE events SET steps = steps + 1 WHERE event_id = ?").run(eventId);
    });
  }

  /** The Grok steps this event has finished, oldest first. */
  steps(eventId: string): ResponseItem[][] {
    return (this.#db.prepare("SELECT output FROM steps WHERE event_id = ? ORDER BY idx").all(eventId) as
      { output: string }[]).map((row) => JSON.parse(row.output) as ResponseItem[]);
  }

  /** Records a tool's result in the chat. */
  append(chatId: string, items: ResponseItem[]): void {
    this.#transaction(() => this.#append(chatId, items));
  }

  /** Marks the event done and drops the media bytes it kept; its upload ids stay. */
  finish(eventId: string): void {
    this.#transaction(() => {
      this.#db.prepare("UPDATE events SET done = 1 WHERE event_id = ?").run(eventId);
      this.#db.prepare("DELETE FROM media WHERE key LIKE ? ESCAPE '\\'").run(`${likeEscape(eventId)}:%`);
    });
  }

  mediaCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM media").get() as { n: number }).n;
  }

  /** A picture or video Grok Imagine already made, so a retry never pays for it twice. */
  media(key: string): Media | undefined {
    const row = this.#db.prepare("SELECT bytes, content_type, filename FROM media WHERE key = ?").get(key) as
      { bytes: Uint8Array; content_type: Media["contentType"]; filename: string } | undefined;
    return row && { bytes: new Uint8Array(row.bytes), contentType: row.content_type, filename: row.filename };
  }

  saveMedia(key: string, media: Media): void {
    this.#db.prepare("INSERT OR REPLACE INTO media (key, bytes, content_type, filename) VALUES (?, ?, ?, ?)")
      .run(key, media.bytes, media.contentType, media.filename);
  }

  upload(key: string): string | undefined {
    return (this.#db.prepare("SELECT attachment_id FROM uploads WHERE key = ?").get(key) as
      { attachment_id: string } | undefined)?.attachment_id;
  }

  saveUpload(key: string, attachmentId: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO uploads (key, attachment_id) VALUES (?, ?)").run(key, attachmentId);
  }

  sent(key: string): string | undefined {
    return (this.#db.prepare("SELECT message_id FROM sent WHERE key = ?").get(key) as
      { message_id: string } | undefined)?.message_id;
  }

  saveSent(key: string, messageId: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO sent (key, message_id) VALUES (?, ?)").run(key, messageId);
  }

  /** Replaces one chat's history with a snapshot rebuilt from Relay (FULL sync). */
  replaceChat(chatId: string, items: ResponseItem[]): void {
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM items WHERE chat_id = ?").run(chatId);
      this.#append(chatId, items);
    });
  }

  close(): void {
    this.#db.close();
  }

  #append(chatId: string, items: ResponseItem[]): void {
    const { next } = this.#db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM items WHERE chat_id = ?")
      .get(chatId) as { next: number };
    const insert = this.#db.prepare("INSERT INTO items (chat_id, seq, item) VALUES (?, ?, ?)");
    items.forEach((item, index) => insert.run(chatId, next + index, JSON.stringify(item)));
  }

  #transaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
