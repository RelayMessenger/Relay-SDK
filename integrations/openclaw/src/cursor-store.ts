// Persisted long-poll cursor, Telegram-offset style (monitor.ts:245-264):
// monotonic writes only, bound to the agent identity so a token that now
// resolves to a different agent discards the stale cursor instead of acking
// another contact's event stream.
export const RELAY_CURSOR_NAMESPACE = "relay.cursors";
export const RELAY_CURSOR_MAX_ENTRIES = 1_000;

const RECORD_VERSION = 1;

export type RelayCursorRecord = {
  version: number;
  cursor: number;
  agentId: string;
};

/**
 * Minimal slice of OpenClaw's PluginStateKeyedStore the cursor needs. The
 * channel runtime binds this to SQLite plugin state via
 * `runtime.state.openKeyedStore`; tests inject a memory map.
 */
export type RelayCursorStateStore = {
  lookup(key: string): Promise<RelayCursorRecord | undefined>;
  register(key: string, value: RelayCursorRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
};

export type RelayCursorStore = {
  /** Loads the persisted cursor; 0 when absent, invalid, or identity-rotated. */
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

function isValidCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createRelayCursorStore(params: {
  store: RelayCursorStateStore;
  accountId: string;
  agentId: string;
  onPersistError?: (error: unknown) => void;
}): RelayCursorStore {
  const key = params.accountId.trim() || "default";
  let cursor = 0;
  let loaded = false;

  return {
    load: async () => {
      loaded = true;
      let record: RelayCursorRecord | undefined;
      try {
        record = await params.store.lookup(key);
      } catch (error) {
        params.onPersistError?.(error);
        cursor = 0;
        return cursor;
      }
      if (
        !record ||
        record.version !== RECORD_VERSION ||
        !isValidCursor(record.cursor) ||
        record.agentId !== params.agentId
      ) {
        // Identity rotation or corrupt state: start fresh rather than acking
        // events that belong to a different agent's sequence space.
        if (record) {
          await params.store.delete(key).catch((error) => params.onPersistError?.(error));
        }
        cursor = 0;
        return cursor;
      }
      cursor = record.cursor;
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
      cursor = next;
      try {
        await params.store.register(key, {
          version: RECORD_VERSION,
          cursor: next,
          agentId: params.agentId,
        });
      } catch (error) {
        // Persistence is best effort: a broken state DB must not stop the
        // receive loop; the in-memory cursor keeps the session correct and a
        // restart replays from the last durable ack (dedupe absorbs it).
        params.onPersistError?.(error);
      }
    },
  };
}
