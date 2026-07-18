// Relay inbound replay protection. The long-poll cursor acknowledges batches,
// so a crash between dispatch and cursor advance
// replays events. Each (account, event) is claimed and durably committed before
// agent dispatch. That gives engine/tool side effects at-most-once semantics:
// an interrupted turn may need the user to resend, but it is never silently
// executed twice.
import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";

const RELAY_INBOUND_DEDUPE_PLUGIN_ID = "relay";
const RELAY_INBOUND_DEDUPE_NAMESPACE = "relay.inbound-attempts";
// One shared namespace with the account baked into each key so per-account
// namespaces cannot starve a new account under the plugin-state row budget.
const RELAY_INBOUND_DEDUPE_SCOPE = "global";
// 30d window: a long outage can replay a deep cursor backlog.
export const RELAY_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RELAY_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 20_000;

/** Minimal claim/commit/release slice of the SDK's ClaimableDedupe. */
export type RelayClaimableGuard = {
  claim: (key: string, opts: { namespace: string }) => Promise<{ kind: string }>;
  commit: (key: string, opts: { namespace: string }) => Promise<unknown>;
  release: (key: string, opts: { namespace: string }) => void;
};

export type RelayAttemptStateStore = {
  lookup(key: string): { attemptedAt: number } | undefined;
  register(key: string, value: { attemptedAt: number }, opts?: { ttlMs?: number }): void;
};

export type RelayInboundDeduper = {
  /** True when the caller now owns the event; false for committed or in-flight duplicates. */
  claimEvent: (eventId: string) => Promise<boolean>;
  /** Records an attempted event before dispatch so restart cannot run it again. */
  commitEvent: (eventId: string) => Promise<void>;
  /** Drops an uncommitted claim so a failed dispatch can retry the event. */
  releaseEvent: (eventId: string) => void;
};

export function buildRelayInboundDedupeKey(params: {
  accountId: string;
  eventId: string;
}): string | null {
  const eventId = params.eventId.trim();
  if (!eventId) {
    return null;
  }
  // NUL separator: event ids are opaque strings, so a printable separator
  // could collide two distinct (account, event) pairs.
  return `${params.accountId.trim() || "default"}\0${eventId}`;
}

export function createRelayInboundDeduper(params: {
  guard: RelayClaimableGuard;
  accountId: string;
}): RelayInboundDeduper {
  const namespace = RELAY_INBOUND_DEDUPE_SCOPE;
  return {
    claimEvent: async (eventId) => {
      const key = buildRelayInboundDedupeKey({ accountId: params.accountId, eventId });
      if (!key) {
        // Fail closed: an event without a durable identity cannot safely
        // cross the at-most-once agent/tool side-effect boundary.
        return false;
      }
      return (await params.guard.claim(key, { namespace })).kind === "claimed";
    },
    commitEvent: async (eventId) => {
      const key = buildRelayInboundDedupeKey({ accountId: params.accountId, eventId });
      if (!key) {
        return;
      }
      await params.guard.commit(key, { namespace });
    },
    releaseEvent: (eventId) => {
      const key = buildRelayInboundDedupeKey({ accountId: params.accountId, eventId });
      if (key) {
        params.guard.release(key, { namespace });
      }
    },
  };
}

function durableAttemptKey(key: string, namespace: string): string {
  return createHash("sha256").update(`${namespace}\0${key}`).digest("hex");
}

/**
 * Strict SQLite-backed guard used by the channel runtime. Unlike a normal
 * message dedupe cache, persistence is not best effort: a failed attempt write
 * must stop before agent dispatch or a crash could execute local tools twice.
 */
export function createRelayInboundDedupeGuard(params?: {
  env?: NodeJS.ProcessEnv;
  onDiskError?: (error: unknown) => void;
  store?: RelayAttemptStateStore;
}): RelayClaimableGuard {
  const store =
    params?.store ??
    createPluginStateSyncKeyedStore<{ attemptedAt: number }>(
      RELAY_INBOUND_DEDUPE_PLUGIN_ID,
      {
        namespace: RELAY_INBOUND_DEDUPE_NAMESPACE,
        maxEntries: RELAY_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: RELAY_INBOUND_DEDUPE_TTL_MS,
        ...(params?.env ? { env: params.env } : {}),
      },
    );
  const inflight = new Set<string>();

  const withDiskError = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      params?.onDiskError?.(error);
      throw error;
    }
  };

  return {
    claim: async (key, opts) => {
      const storageKey = durableAttemptKey(key, opts.namespace);
      if (inflight.has(storageKey)) {
        return { kind: "inflight" };
      }
      if (withDiskError(() => store.lookup(storageKey)) !== undefined) {
        return { kind: "duplicate" };
      }
      inflight.add(storageKey);
      return { kind: "claimed" };
    },
    commit: async (key, opts) => {
      const storageKey = durableAttemptKey(key, opts.namespace);
      try {
        withDiskError(() =>
          store.register(
            storageKey,
            { attemptedAt: Date.now() },
            { ttlMs: RELAY_INBOUND_DEDUPE_TTL_MS },
          ),
        );
        return true;
      } finally {
        inflight.delete(storageKey);
      }
    },
    release: (key, opts) => {
      inflight.delete(durableAttemptKey(key, opts.namespace));
    },
  };
}
