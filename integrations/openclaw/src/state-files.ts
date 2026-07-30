import { jsonStore } from "@openclaw/fs-safe/store";
import type { JsonStore } from "@openclaw/fs-safe/store";
import { withFileLock } from "@openclaw/fs-safe/file-lock";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";

const RELAY_STATE_DOCUMENT_VERSION = 1;
const RELAY_STATE_LOCK_VERSION = 1;
const RELAY_STATE_LOCK_TIMEOUT_MS = 30_000;

type RelayStateLockOwner = {
  version: typeof RELAY_STATE_LOCK_VERSION;
  kind: "relay-state";
  pid: number;
  host: string;
  createdAt: string;
};

export type RelayStateDocument<T> = {
  version: typeof RELAY_STATE_DOCUMENT_VERSION;
  entries: Record<string, T>;
};

export function emptyRelayStateDocument<T>(): RelayStateDocument<T> {
  return { version: RELAY_STATE_DOCUMENT_VERSION, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertRelayStateDocument<T>(
  value: unknown,
  label: string,
  validateEntry: (key: string, value: unknown) => value is T,
): asserts value is RelayStateDocument<T> {
  if (
    !isRecord(value) ||
    value.version !== RELAY_STATE_DOCUMENT_VERSION ||
    !isRecord(value.entries)
  ) {
    throw new Error(`relay ${label} state is corrupt`);
  }
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!validateEntry(key, entry)) {
      throw new Error(`relay ${label} state is corrupt`);
    }
  }
}

function isRelayStateLockOwner(value: unknown): value is RelayStateLockOwner {
  if (!isRecord(value)) return false;
  return (
    value.version === RELAY_STATE_LOCK_VERSION &&
    value.kind === "relay-state" &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function localProcessIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists but is owned by another user. Unknown
    // failures also fail closed; only ESRCH proves this host no longer has it.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function canRecoverRelayStateLock(value: unknown): boolean {
  return (
    isRelayStateLockOwner(value) &&
    value.host === hostname() &&
    !localProcessIsLive(value.pid)
  );
}

function ensurePrivateStateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`relay state path is not a private directory: ${path}`);
  }
  try {
    chmodSync(path, 0o700);
  } catch {
    // POSIX modes are not fully implemented on Windows. fs-safe's private
    // write path still owns the platform-specific file guarantees.
  }
}

/**
 * Relay owns these files rather than requesting OpenClaw's privileged host
 * SQLite. jsonStore gives every mutation a private atomic replacement. An
 * fs-safe sidecar lock serializes cross-process mutations and is recovered
 * only when its valid Relay owner names this host and its PID is provably dead.
 */
export function openRelayStateDocument<T>(params: {
  fileName: string;
  env?: NodeJS.ProcessEnv;
  lockTimeoutMs?: number;
}): JsonStore<RelayStateDocument<T>> {
  if (!params.fileName || basename(params.fileName) !== params.fileName) {
    throw new Error("relay state fileName must be one file name");
  }
  const lockTimeoutMs = params.lockTimeoutMs ?? RELAY_STATE_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new Error("relay state lockTimeoutMs must be a positive safe integer");
  }
  const stateRoot = resolveStateDir(params.env ?? process.env);
  const relayRoot = join(stateRoot, "relay");
  const relayStateRoot = join(relayRoot, "state");
  ensurePrivateStateDirectory(relayRoot);
  ensurePrivateStateDirectory(relayStateRoot);
  const store = jsonStore<RelayStateDocument<T>>({
    filePath: join(relayStateRoot, params.fileName),
    dirMode: 0o700,
    mode: 0o600,
  });
  const withMutationLock = async <R>(run: () => Promise<R>): Promise<R> =>
    await withFileLock(
      store.filePath,
      {
        managerKey: `relay-state:${store.filePath}`,
        staleMs: RELAY_STATE_LOCK_TIMEOUT_MS,
        timeoutMs: lockTimeoutMs,
        staleRecovery: "remove-if-unchanged",
        retry: {
          retries: 300,
          minTimeout: 25,
          maxTimeout: 250,
          randomize: true,
        },
        payload: (): RelayStateLockOwner => ({
          version: RELAY_STATE_LOCK_VERSION,
          kind: "relay-state",
          pid: process.pid,
          host: hostname(),
          createdAt: new Date().toISOString(),
        }),
        shouldReclaim: ({ payload }) => canRecoverRelayStateLock(payload),
        shouldRemoveStaleLock: ({ payload }) => canRecoverRelayStateLock(payload),
      },
      run,
    );

  return {
    filePath: store.filePath,
    read: store.read,
    readOr: store.readOr,
    readRequired: store.readRequired,
    write: async (value) => {
      await withMutationLock(async () => await store.write(value));
    },
    update: async (run) =>
      await withMutationLock(async () => await store.update(run)),
    updateOr: async (fallback, run) =>
      await withMutationLock(async () => await store.updateOr(fallback, run)),
  };
}
