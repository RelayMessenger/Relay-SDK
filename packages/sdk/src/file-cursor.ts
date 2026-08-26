import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FileCursorStore = {
  load(): number;
  current(): number;
  advance(next: number): void;
};

/**
 * Simple durable cursor file for `GET /v1/events` pollers: it holds the last
 * sequence handled, to send back as `after`.
 * Advances are monotonic; a corrupt file refuses to reset to zero silently.
 */
export function createFileCursorStore(path: string): FileCursorStore {
  let cursor = 0;
  let loaded = false;

  const read = (): number => {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { cursor?: unknown };
      if (
        typeof parsed.cursor !== "number" ||
        !Number.isSafeInteger(parsed.cursor) ||
        parsed.cursor < 0
      ) {
        throw new Error(`corrupt cursor file: ${path}`);
      }
      return parsed.cursor;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return 0;
      throw error;
    }
  };

  const write = (value: number) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ cursor: value })}\n`, { mode: 0o600 });
  };

  return {
    load: () => {
      cursor = read();
      loaded = true;
      return cursor;
    },
    current: () => {
      if (!loaded) throw new Error("relay cursor: current() before load()");
      return cursor;
    },
    advance: (next) => {
      if (!loaded) throw new Error("relay cursor: advance() before load()");
      if (!Number.isSafeInteger(next) || next < 0 || next <= cursor) return;
      write(next);
      cursor = next;
    },
  };
}
