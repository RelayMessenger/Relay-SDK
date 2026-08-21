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

/**
 * Windows opens the sidecar lock with an openat-style
 * `O_CREAT | O_EXCL` beneath a parent handle. While a just-released lock file
 * is still delete-pending, that create returns `ACCESS_DENIED` instead of the
 * `already exists` fs-safe retries on, so contention escapes the acquire loop
 * as a hard `EACCES`. Retry those on Windows only, bounded by the caller's lock
 * timeout: a genuine permission failure simply reproduces until the deadline
 * and then surfaces unchanged.
 */
function isWindowsLockAcquisitionContention(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

function lockRetryDelayMs(attempt: number, remainingMs: number): number {
  const backoff = Math.min(25 * 2 ** attempt, 250);
  return Math.max(1, Math.min(backoff * (0.5 + Math.random() / 2), remainingMs));
}

/**
 * The sidecar lock has no in-process fast path: every waiter polls the lock
 * file, and losing an attempt costs an exclusive create plus a snapshot read.
 * Relay mutates one document from several tasks at once — a poll batch
 * registers one dedupe entry per inbound message — so N in-process writers
 * become N pollers competing with the holder for the same file. Funnelling
 * them through one in-memory queue leaves a single poller per process, which
 * matters most on Windows: same-process losers no longer race the holder's
 * unlink, so contention stops manifesting as delete-pending denials.
 *
 * Keyed by the store's file path. Two paths spelled differently for one file
 * would each get a queue and simply fall back to the sidecar lock for
 * correctness, so a miss costs throughput rather than serialization.
 */
const RELAY_STATE_MUTEX_KEY = Symbol.for("relay.stateFileMutexes");

function stateFileMutexes(): Map<string, Promise<void>> {
  const container = globalThis as typeof globalThis & {
    [RELAY_STATE_MUTEX_KEY]?: Map<string, Promise<void>>;
  };
  container[RELAY_STATE_MUTEX_KEY] ??= new Map<string, Promise<void>>();
  return container[RELAY_STATE_MUTEX_KEY];
}

function fileLockTimeout(filePath: string): Error {
  return Object.assign(new Error(`file lock timeout for ${filePath}`), {
    code: "file_lock_timeout",
  });
}

/** Waits for our turn, but never past the caller's lock deadline. */
async function awaitTurn(
  turn: Promise<void>,
  deadline: number,
  filePath: string,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw fileLockTimeout(filePath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      turn,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(fileLockTimeout(filePath)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withStateFileMutex<R>(
  filePath: string,
  deadline: number,
  run: () => Promise<R>,
): Promise<R> {
  const mutexes = stateFileMutexes();
  const previous = mutexes.get(filePath);
  let release!: () => void;
  const ours = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain even when we abandon our turn on timeout: later waiters still queue
  // behind the holder we were waiting on, so ordering survives a giving-up
  // waiter.
  const tail = previous ? previous.then(() => ours) : ours;
  mutexes.set(filePath, tail);
  let tookTurn = false;
  try {
    if (previous) await awaitTurn(previous, deadline, filePath);
    tookTurn = true;
    return await run();
  } finally {
    release();
    // Forgetting the queue is only safe once it has drained. A waiter that gave
    // up is still queued behind a holder that is running, so dropping the entry
    // there would let the next caller past the holder and back onto the lock
    // file the queue exists to keep it off. Leaving it costs one settled promise
    // until the next caller drains it.
    if (tookTurn && mutexes.get(filePath) === tail) mutexes.delete(filePath);
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
  const withMutationLock = async <R>(run: () => Promise<R>): Promise<R> => {
    const deadline = Date.now() + lockTimeoutMs;
    return await withStateFileMutex(store.filePath, deadline, async () => {
      for (let attempt = 0; ; attempt += 1) {
        // Only acquisition is retried. Once the mutation itself has started it
        // has observed state under the lock, so replaying it could double-apply.
        let mutationStarted = false;
        try {
          return await withFileLock(
            store.filePath,
            {
              managerKey: `relay-state:${store.filePath}`,
              staleMs: RELAY_STATE_LOCK_TIMEOUT_MS,
              timeoutMs: Math.max(1, deadline - Date.now()),
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
              shouldRemoveStaleLock: ({ payload }) =>
                canRecoverRelayStateLock(payload),
            },
            async () => {
              mutationStarted = true;
              return await run();
            },
          );
        } catch (error) {
          const remaining = deadline - Date.now();
          if (
            mutationStarted ||
            remaining <= 0 ||
            !isWindowsLockAcquisitionContention(error)
          ) {
            throw error;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, lockRetryDelayMs(attempt, remaining)),
          );
        }
      }
    });
  };

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
