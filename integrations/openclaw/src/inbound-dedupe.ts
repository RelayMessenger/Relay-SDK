// Relay inbound replay protection, mirroring the Matrix pattern
// (extensions/matrix/src/matrix/monitor/inbound-dedupe.ts): the long-poll
// cursor acknowledges batches, so a crash between dispatch and cursor advance
// replays events. Each (account, event) is claimed before dispatch and
// committed only after dispatch succeeds; release on retryable failure
// reopens the event for the replay.
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

const RELAY_INBOUND_DEDUPE_PLUGIN_ID = "relay";
const RELAY_INBOUND_DEDUPE_NAMESPACE_PREFIX = "relay.inbound-dedupe";
// One shared namespace with the account baked into each key (Matrix rationale:
// per-account namespaces could starve a new account under the per-plugin
// plugin-state row budget).
const RELAY_INBOUND_DEDUPE_NAMESPACE = "global";
// 30d window: a long outage can replay a deep cursor backlog.
export const RELAY_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RELAY_INBOUND_DEDUPE_MEMORY_MAX = 5_000;
export const RELAY_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 20_000;

/** Minimal claim/commit/release slice of the SDK's ClaimableDedupe. */
export type RelayClaimableGuard = {
  claim: (key: string, opts: { namespace: string }) => Promise<{ kind: string }>;
  commit: (key: string, opts: { namespace: string }) => Promise<unknown>;
  release: (key: string, opts: { namespace: string }) => void;
};

export type RelayInboundDeduper = {
  /** True when the caller now owns the event; false for committed or in-flight duplicates. */
  claimEvent: (eventId: string) => Promise<boolean>;
  /** Records a handled event so restart/replay cannot dispatch it again. */
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
  const namespace = RELAY_INBOUND_DEDUPE_NAMESPACE;
  return {
    claimEvent: async (eventId) => {
      const key = buildRelayInboundDedupeKey({ accountId: params.accountId, eventId });
      if (!key) {
        // Fail open: never suppress an event we cannot identify.
        return true;
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

/** SQLite-backed guard used by the channel runtime (persistence best effort). */
export function createRelayInboundDedupeGuard(params?: {
  env?: NodeJS.ProcessEnv;
  onDiskError?: (error: unknown) => void;
}): RelayClaimableGuard {
  return createClaimableDedupe({
    pluginId: RELAY_INBOUND_DEDUPE_PLUGIN_ID,
    namespacePrefix: RELAY_INBOUND_DEDUPE_NAMESPACE_PREFIX,
    ttlMs: RELAY_INBOUND_DEDUPE_TTL_MS,
    memoryMaxSize: RELAY_INBOUND_DEDUPE_MEMORY_MAX,
    stateMaxEntries: RELAY_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
    ...(params?.env ? { env: params.env } : {}),
    onDiskError: (error) => {
      params?.onDiskError?.(error);
    },
  });
}
