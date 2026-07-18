// Persisted long-poll cursor, Telegram-offset style (monitor.ts:245-264):
// monotonic writes only, bound to the agent identity so a token that now
// resolves to a different agent discards the stale cursor instead of acking
// another contact's event stream.
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";

export const RELAY_CURSOR_NAMESPACE = "relay.cursors";
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
 * Open the durable SQLite namespace with fail-closed capacity semantics. A
 * cursor is permanent safety state: evicting an old identity to admit a new
 * one could replay retained events when the old identity returns.
 */
export function openRelayCursorStateStore(
  warn: (line: string) => void,
  options: { env?: NodeJS.ProcessEnv; maxEntries?: number } = {},
): RelayCursorStateStore {
  try {
    const store = createPluginStateSyncKeyedStore<RelayCursorRecord>("relay", {
      namespace: RELAY_CURSOR_NAMESPACE,
      maxEntries: options.maxEntries ?? RELAY_CURSOR_MAX_ENTRIES,
      overflowPolicy: RELAY_CURSOR_OVERFLOW_POLICY,
      ...(options.env ? { env: options.env } : {}),
    });
    return {
      lookup: async (key) => store.lookup(key),
      register: async (key, value) => {
        store.register(key, value);
      },
      delete: async (key) => store.delete(key),
    };
  } catch (error) {
    warn(`[relay] plugin state unavailable; refusing unsafe cursor reset: ${String(error)}`);
    throw error;
  }
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
