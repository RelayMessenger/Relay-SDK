// Relay inbound replay protection. The long-poll cursor acknowledges batches,
// so a crash between dispatch and cursor advance
// replays events. Each (canonical origin, agent, event) is claimed, safely
// preflighted, and durably committed immediately before agent dispatch. That
// gives engine/tool side effects at-most-once semantics:
// an interrupted turn may need the user to resend, but it is never silently
// executed twice.
import { createHash } from "node:crypto";
import {
  assertRelayStateDocument,
  emptyRelayStateDocument,
  openRelayStateDocument,
} from "./state-files.js";

// One shared namespace with stable Relay identity baked into each key so local
// account renames cannot reset safety state or partition the row budget.
const RELAY_INBOUND_DEDUPE_SCOPE = "global";
// 30d window: a long outage can replay a deep cursor backlog.
export const RELAY_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RELAY_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 20_000;

type MaybePromise<T> = T | Promise<T>;

/** Minimal claim/commit/release slice of the SDK's ClaimableDedupe. */
export type RelayClaimableGuard = {
  claim: (key: string, opts: { namespace: string }) => Promise<{ kind: string }>;
  commit: (key: string, opts: { namespace: string }) => Promise<unknown>;
  release: (key: string, opts: { namespace: string }) => void;
};

export type RelayAttemptStateStore = {
  lookup(key: string): MaybePromise<{ attemptedAt: number } | undefined>;
  register(
    key: string,
    value: { attemptedAt: number },
    opts?: { ttlMs?: number },
  ): MaybePromise<void>;
};

export type RelayInboundDeduper = {
  /** True when the caller now owns the event; false for committed or in-flight duplicates. */
  claimEvent: (eventId: string) => Promise<boolean>;
  /** Records an attempted event at the agent-dispatch boundary so restart cannot run it again. */
  commitEvent: (eventId: string) => Promise<void>;
  /** Drops an uncommitted claim so a failed dispatch can retry the event. */
  releaseEvent: (eventId: string) => void;
};

export function buildRelayInboundDedupeKey(params: {
  baseUrl: string;
  agentId: string;
  eventId: string;
}): string | null {
  const eventId = params.eventId.trim();
  if (!eventId) {
    return null;
  }
  // NUL separator: event ids are opaque strings, so a printable separator
  // could collide two distinct (account, event) pairs.
  return `${new URL(params.baseUrl).origin}\0${params.agentId}\0${eventId}`;
}

export function createRelayInboundDeduper(params: {
  guard: RelayClaimableGuard;
  baseUrl: string;
  agentId: string;
}): RelayInboundDeduper {
  const namespace = RELAY_INBOUND_DEDUPE_SCOPE;
  return {
    claimEvent: async (eventId) => {
      const key = buildRelayInboundDedupeKey({ baseUrl: params.baseUrl, agentId: params.agentId, eventId });
      if (!key) {
        // Fail closed: an event without a durable identity cannot safely
        // cross the at-most-once agent/tool side-effect boundary.
        return false;
      }
      return (await params.guard.claim(key, { namespace })).kind === "claimed";
    },
    commitEvent: async (eventId) => {
      const key = buildRelayInboundDedupeKey({ baseUrl: params.baseUrl, agentId: params.agentId, eventId });
      if (!key) {
        return;
      }
      await params.guard.commit(key, { namespace });
    },
    releaseEvent: (eventId) => {
      const key = buildRelayInboundDedupeKey({ baseUrl: params.baseUrl, agentId: params.agentId, eventId });
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
 * Strict Relay-owned guard used by the channel runtime. Unlike a normal
 * message dedupe cache, persistence is not best effort: a failed attempt write
 * must stop before agent dispatch or a crash could execute local tools twice.
 */
export function createRelayInboundDedupeGuard(params?: {
  env?: NodeJS.ProcessEnv;
  onDiskError?: (error: unknown) => void;
  store?: RelayAttemptStateStore;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}): RelayClaimableGuard {
  type PersistedAttempt = { attemptedAt: number; expiresAt: number };
  const now = params?.now ?? Date.now;
  const ttlMs = params?.ttlMs ?? RELAY_INBOUND_DEDUPE_TTL_MS;
  const maxEntries = params?.maxEntries ?? RELAY_INBOUND_DEDUPE_STATE_MAX_ENTRIES;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error("relay inbound dedupe ttlMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("relay inbound dedupe maxEntries must be a positive safe integer");
  }
  const readNow = (): number => {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error("relay inbound dedupe clock returned an invalid timestamp");
    }
    return timestamp;
  };
  const isPersistedAttempt = (key: string, value: unknown): value is PersistedAttempt => {
    if (!/^[a-f0-9]{64}$/u.test(key) || !value || typeof value !== "object") return false;
    const entry = value as Partial<PersistedAttempt>;
    return (
      typeof entry.attemptedAt === "number" &&
      Number.isSafeInteger(entry.attemptedAt) &&
      entry.attemptedAt >= 0 &&
      typeof entry.expiresAt === "number" &&
      Number.isSafeInteger(entry.expiresAt) &&
      entry.expiresAt > entry.attemptedAt
    );
  };
  const state = params?.store
    ? undefined
    : openRelayStateDocument<PersistedAttempt>({
        fileName: "inbound-attempts.json",
        ...(params?.env ? { env: params.env } : {}),
      });
  const store =
    params?.store ??
    {
      lookup: async (key: string) => {
        const current = await state!.read();
        if (current === undefined) return undefined;
        assertRelayStateDocument(current, "inbound attempt", isPersistedAttempt);
        const entry = current.entries[key];
        if (!entry || entry.expiresAt <= readNow()) return undefined;
        return { attemptedAt: entry.attemptedAt };
      },
      register: async (
        key: string,
        value: { attemptedAt: number },
        opts?: { ttlMs?: number },
      ) => {
        await state!.updateOr(emptyRelayStateDocument<PersistedAttempt>(), (current) => {
          assertRelayStateDocument(current, "inbound attempt", isPersistedAttempt);
          const timestamp = readNow();
          const entryTtlMs = opts?.ttlMs ?? ttlMs;
          if (!Number.isSafeInteger(entryTtlMs) || entryTtlMs < 1) {
            throw new Error("relay inbound dedupe ttlMs must be a positive safe integer");
          }
          const expiresAt = value.attemptedAt + entryTtlMs;
          if (!Number.isSafeInteger(expiresAt)) {
            throw new Error("relay inbound dedupe expiration exceeds safe integer range");
          }
          const liveEntries = Object.fromEntries(
            Object.entries(current.entries).filter(([, entry]) => entry.expiresAt > timestamp),
          );
          liveEntries[key] = {
            attemptedAt: value.attemptedAt,
            expiresAt,
          };
          const ordered = Object.entries(liveEntries).sort(
            ([leftKey, left], [rightKey, right]) =>
              left.attemptedAt - right.attemptedAt || leftKey.localeCompare(rightKey),
          );
          const retained = ordered.slice(Math.max(ordered.length - maxEntries, 0));
          return {
            version: current.version,
            entries: Object.fromEntries(retained),
          };
        });
      },
    } satisfies RelayAttemptStateStore;
  const inflight = new Set<string>();
  const claiming = new Set<string>();

  const withDiskError = async <T>(operation: () => MaybePromise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      params?.onDiskError?.(error);
      throw error;
    }
  };

  return {
    claim: async (key, opts) => {
      const storageKey = durableAttemptKey(key, opts.namespace);
      if (inflight.has(storageKey) || claiming.has(storageKey)) {
        return { kind: "inflight" };
      }
      claiming.add(storageKey);
      try {
        if ((await withDiskError(() => store.lookup(storageKey))) !== undefined) {
          return { kind: "duplicate" };
        }
        inflight.add(storageKey);
        return { kind: "claimed" };
      } finally {
        claiming.delete(storageKey);
      }
    },
    commit: async (key, opts) => {
      const storageKey = durableAttemptKey(key, opts.namespace);
      try {
        await withDiskError(() =>
          store.register(
            storageKey,
            { attemptedAt: readNow() },
            { ttlMs },
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
