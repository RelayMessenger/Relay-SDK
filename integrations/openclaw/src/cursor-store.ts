// Persisted long-poll cursor, Telegram-offset style:
// monotonic writes only, bound to the agent identity so a token that now
// resolves to a different agent discards the stale cursor instead of acking
// another contact's event stream.
import { createHash } from "node:crypto";
import {
  assertRelayStateDocument,
  emptyRelayStateDocument,
  openRelayStateDocument,
} from "./state-files.js";

export const RELAY_CURSOR_MAX_ENTRIES = 1_000;
export const RELAY_CURSOR_OVERFLOW_POLICY = "reject-new" as const;

const RECORD_VERSION = 2;

export type RelayCursorRecord = {
  version: number;
  cursor: number;
  baseUrl: string;
  agentId: string;
};

/**
 * Minimal state-store slice the cursor needs. The channel runtime binds this
 * to Relay-owned files; tests can inject a memory map.
 */
export type RelayCursorStateStore = {
  lookup(key: string): Promise<RelayCursorRecord | undefined>;
  register(key: string, value: RelayCursorRecord): Promise<void>;
};

export type RelayCursorStore = {
  /** Loads the persisted cursor; only a genuinely absent stable identity starts at 0. */
  load(): Promise<number>;
  /** Last accepted cursor (in-memory view). */
  current(): number;
  /**
   * Persist a new cursor. Only called after the batch it acknowledges has been
   * durably handled (claim/commit); ignores non-monotonic or invalid values so
   * a replayed batch can never move the ack backwards.
   */
  advance(cursor: number): Promise<void>;
};

/**
 * Open Relay's private, lock-protected state file with fail-closed capacity
 * semantics. A cursor is permanent safety state: evicting an old identity to
 * admit a new one could replay retained events when the old identity returns.
 */
export function openRelayCursorStateStore(
  warn: (line: string) => void,
  options: { env?: NodeJS.ProcessEnv; maxEntries?: number } = {},
): RelayCursorStateStore {
  const maxEntries = options.maxEntries ?? RELAY_CURSOR_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("relay cursor maxEntries must be a positive safe integer");
  }
  const store = openRelayStateDocument<RelayCursorRecord>({
    fileName: "cursors.json",
    ...(options.env ? { env: options.env } : {}),
  });
  const storageKey = (key: string) => createHash("sha256").update(key).digest("hex");
  const validateEntry = (key: string, value: unknown): value is RelayCursorRecord => {
    if (!/^[a-f0-9]{64}$/u.test(key) || !value || typeof value !== "object") return false;
    const record = value as Partial<RelayCursorRecord>;
    return (
      record.version === RECORD_VERSION &&
      isValidCursor(record.cursor) &&
      typeof record.baseUrl === "string" &&
      (() => {
        try {
          return new URL(record.baseUrl).origin === record.baseUrl;
        } catch {
          return false;
        }
      })() &&
      typeof record.agentId === "string" &&
      record.agentId.length > 0
    );
  };
  const read = async () => {
    try {
      const current = await store.read();
      if (current === undefined) return emptyRelayStateDocument<RelayCursorRecord>();
      assertRelayStateDocument(current, "cursor", validateEntry);
      return current;
    } catch (error) {
      warn(`[relay] cursor state unavailable; refusing unsafe cursor reset: ${String(error)}`);
      throw error;
    }
  };
  return {
    lookup: async (key) => (await read()).entries[storageKey(key)],
    register: async (key, value) => {
      try {
        await store.updateOr(emptyRelayStateDocument<RelayCursorRecord>(), (current) => {
          assertRelayStateDocument(current, "cursor", validateEntry);
          const hashedKey = storageKey(key);
          if (
            !Object.hasOwn(current.entries, hashedKey) &&
            Object.keys(current.entries).length >= maxEntries
          ) {
            throw new Error(
              `relay cursor state reached ${maxEntries} identities (${RELAY_CURSOR_OVERFLOW_POLICY})`,
            );
          }
          return {
            version: current.version,
            entries: { ...current.entries, [hashedKey]: value },
          };
        });
      } catch (error) {
        warn(`[relay] cursor state unavailable; refusing unsafe cursor reset: ${String(error)}`);
        throw error;
      }
    },
  };
}

function isValidCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createRelayCursorStore(params: {
  store: RelayCursorStateStore;
  baseUrl: string;
  agentId: string;
  onPersistError?: (error: unknown) => void;
}): RelayCursorStore {
  const baseUrl = new URL(params.baseUrl).origin;
  const key = `relay:${baseUrl}:${params.agentId}`;
  let cursor = 0;
  let loaded = false;

  return {
    load: async () => {
      let record: RelayCursorRecord | undefined;
      try {
        record = await params.store.lookup(key);
      } catch (error) {
        params.onPersistError?.(error);
        throw new Error(`relay cursor state could not be loaded: ${String(error)}`);
      }
      if (!record) {
        cursor = 0;
        loaded = true;
        return cursor;
      }
      if (
        record.version !== RECORD_VERSION ||
        !isValidCursor(record.cursor) ||
        record.agentId !== params.agentId ||
        record.baseUrl !== baseUrl
      ) {
        throw new Error(`relay cursor state is corrupt for ${baseUrl} ${params.agentId}; refusing cursor-zero replay`);
      }
      cursor = record.cursor;
      loaded = true;
      return cursor;
    },

    current: () => cursor,

    advance: async (next) => {
      if (!loaded) {
        throw new Error("relay cursor store: advance() before load()");
      }
      if (!isValidCursor(next) || next <= cursor) {
        return;
      }
      try {
        await params.store.register(key, {
          version: RECORD_VERSION,
          cursor: next,
          baseUrl,
          agentId: params.agentId,
        });
      } catch (error) {
        params.onPersistError?.(error);
        throw new Error(`relay cursor advance was not durable: ${String(error)}`);
      }
      cursor = next;
    },
  };
}
