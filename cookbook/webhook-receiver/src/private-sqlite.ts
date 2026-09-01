import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  symlinkSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  parse,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_STICKY_TEMP_DIRECTORIES = new Set([
  "/private/tmp",
  "/private/var/tmp",
  "/tmp",
  "/var/tmp",
]);

export interface PrivateSqliteTestHooks {
  /** Fault/identity injection used only by filesystem safety tests. */
  directoryUidOverride?: {
    path: string;
    uid: number;
  };
  raceDirectoryCreate?: {
    path: string;
    target: string;
  };
}

interface ResolvedTestHooks {
  directoryUidOverride?: {
    path: string;
    uid: number;
  };
  raceDirectoryCreate?: {
    path: string;
    target: string;
  };
}

function systemPath(path: string): string {
  if (process.platform !== "darwin") return path;
  for (const [alias, canonical] of [
    ["/etc", "/private/etc"],
    ["/tmp", "/private/tmp"],
    ["/var", "/private/var"],
  ] as const) {
    if (path === alias) return canonical;
    if (path.startsWith(`${alias}/`)) {
      return `${canonical}${path.slice(alias.length)}`;
    }
  }
  return path;
}

function resolveTestHooks(
  hooks: PrivateSqliteTestHooks,
): ResolvedTestHooks {
  return {
    ...(hooks.directoryUidOverride
      ? {
        directoryUidOverride: {
          path: systemPath(resolve(hooks.directoryUidOverride.path)),
          uid: hooks.directoryUidOverride.uid,
        },
      }
      : {}),
    ...(hooks.raceDirectoryCreate
      ? {
        raceDirectoryCreate: {
          path: systemPath(resolve(hooks.raceDirectoryCreate.path)),
          target: systemPath(resolve(hooks.raceDirectoryCreate.target)),
        },
      }
      : {}),
  };
}

function descriptorEntry(parentFd: number, name: string): string {
  // Linux procfs magic links resolve `name` from the held directory
  // descriptor even if its former pathname is concurrently renamed.
  return `/proc/self/fd/${parentFd}/${name}`;
}

function currentUid(): number {
  if (typeof process.geteuid !== "function") {
    throw new Error("Private Relay SQLite paths require POSIX ownership");
  }
  return process.geteuid();
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "EEXIST";
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function observedDirectoryUid(
  path: string,
  stats: Stats,
  hooks: ResolvedTestHooks,
): number {
  return hooks.directoryUidOverride?.path === path
    ? hooks.directoryUidOverride.uid
    : stats.uid;
}

function assertDirectory(
  path: string,
  stats: Stats,
  immediate: boolean,
  label: string,
  hooks: ResolvedTestHooks,
): void {
  if (!stats.isDirectory()) {
    throw new Error(`${label} path component is not a directory`);
  }

  const uid = observedDirectoryUid(path, stats, hooks);
  const owner = currentUid();
  const mode = stats.mode & 0o7777;
  if (immediate) {
    if (uid !== owner) {
      throw new Error(`${label} directory must be owned by the current user`);
    }
    if ((mode & 0o777) !== 0o700) {
      throw new Error(`${label} directory must be owner-only (0700)`);
    }
    return;
  }

  if (uid !== 0 && uid !== owner) {
    throw new Error(
      `${label} ancestor directory must be owned by root or the current user`,
    );
  }
  if ((mode & 0o022) === 0) return;

  const trustedTempRoot = uid === 0
    && (mode & 0o1000) !== 0
    && ROOT_STICKY_TEMP_DIRECTORIES.has(path);
  if (!trustedTempRoot) {
    throw new Error(
      `${label} ancestor directory must not be group- or world-writable`,
    );
  }
}

function openDirectory(
  path: string,
  immediate: boolean,
  label: string,
  hooks: ResolvedTestHooks,
): number {
  const fd = openSync(
    path,
    constants.O_RDONLY
      | constants.O_DIRECTORY
      | constants.O_NOFOLLOW,
  );
  try {
    assertDirectory(path, fstatSync(fd), immediate, label, hooks);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openDirectoryAt(
  parentFd: number,
  name: string,
  path: string,
  immediate: boolean,
  label: string,
  hooks: ResolvedTestHooks,
): number {
  const entry = descriptorEntry(parentFd, name);
  let before = lstatIfPresent(entry);
  let created = false;
  if (!before) {
    if (hooks.raceDirectoryCreate?.path === path) {
      symlinkSync(hooks.raceDirectoryCreate.target, path);
    }
    try {
      mkdirSync(entry, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (isAlreadyPresent(error)) {
        throw new Error(`${label} path changed while it was being created`);
      }
      throw error;
    }
    before = lstatIfPresent(entry);
    if (!before) {
      throw new Error(`${label} directory could not be created safely`);
    }
  }
  if (before.isSymbolicLink()) {
    throw new Error(`${label} path must not contain symbolic links`);
  }
  if (!before.isDirectory()) {
    throw new Error(`${label} path component is not a directory`);
  }

  const fd = openSync(
    entry,
    constants.O_RDONLY
      | constants.O_DIRECTORY
      | constants.O_NOFOLLOW,
  );
  try {
    let opened = fstatSync(fd);
    if (!sameIdentity(before, opened)) {
      throw new Error(`${label} path changed while it was being opened`);
    }
    if (created) {
      fchmodSync(fd, 0o700);
      opened = fstatSync(fd);
    }
    assertDirectory(path, opened, immediate, label, hooks);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertPrivateFile(
  stats: Stats,
  label: string,
): void {
  if (!stats.isFile()) {
    throw new Error(`${label} database must be a regular file`);
  }
  if (stats.uid !== currentUid()) {
    throw new Error(`${label} database must be owned by the current user`);
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error(`${label} database must be owner-only (0600)`);
  }
}

function prepareFileAt(
  parentFd: number,
  name: string,
  label: string,
): void {
  const entry = descriptorEntry(parentFd, name);
  const before = lstatIfPresent(entry);
  if (before?.isSymbolicLink()) {
    throw new Error(`${label} database must not be a symbolic link`);
  }
  if (before) assertPrivateFile(before, label);

  const created = before === undefined;
  const fd = openSync(
    entry,
    created
      ? constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW
      : constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (created) fchmodSync(fd, 0o600);
    const opened = fstatSync(fd);
    const linked = lstatIfPresent(entry);
    if (!linked || !sameIdentity(linked, opened)) {
      throw new Error(`${label} database changed while it was being opened`);
    }
    assertPrivateFile(opened, label);
  } finally {
    closeSync(fd);
  }
}

function prepareLinuxPath(
  path: string,
  label: string,
  hooks: ResolvedTestHooks,
): void {
  const directory = dirname(path);
  const root = parse(directory).root;
  const names = directory
    .slice(root.length)
    .split(sep)
    .filter(Boolean);

  let parentFd = openDirectory(
    root,
    names.length === 0,
    label,
    hooks,
  );
  let parentPath = root;
  try {
    for (const [index, name] of names.entries()) {
      const childPath = resolve(parentPath, name);
      const childFd = openDirectoryAt(
        parentFd,
        name,
        childPath,
        index === names.length - 1,
        label,
        hooks,
      );
      closeSync(parentFd);
      parentFd = childFd;
      parentPath = childPath;
    }
    prepareFileAt(parentFd, basename(path), label);
  } finally {
    closeSync(parentFd);
  }
}

function prepareDarwinPath(
  path: string,
  label: string,
  hooks: ResolvedTestHooks,
): void {
  const helper = fileURLToPath(new URL(
    "../dist/private-sqlite-openat",
    import.meta.url,
  ));
  const args = [path, label];
  if (hooks.directoryUidOverride) {
    args.push(
      "--test-uid-path",
      hooks.directoryUidOverride.path,
      "--test-uid",
      String(hooks.directoryUidOverride.uid),
    );
  }
  if (hooks.raceDirectoryCreate) {
    args.push(
      "--test-race-path",
      hooks.raceDirectoryCreate.path,
      "--test-race-target",
      hooks.raceDirectoryCreate.target,
    );
  }

  const result = spawnSync(helper, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error(
        `${label} macOS openat helper is not built; run npm run build:native`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim()
      || `${label} macOS openat helper failed with status ${result.status}`,
    );
  }
}

export function preparePrivateSqlitePath(
  filename: string,
  label: string,
  hooks: PrivateSqliteTestHooks = {},
): string {
  const path = systemPath(resolve(filename));
  const resolvedHooks = resolveTestHooks(hooks);
  if (process.platform === "linux") {
    prepareLinuxPath(path, label, resolvedHooks);
  } else if (process.platform === "darwin") {
    prepareDarwinPath(path, label, resolvedHooks);
  } else {
    throw new Error(
      "Private Relay SQLite paths require Linux or macOS openat support",
    );
  }
  return path;
}
