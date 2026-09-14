import { inspectWindowsAcl, privateWindowsAcl, protectWindowsPath } from "./runtime-connect/windows-acl.js";
import { access, chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * One writer for every file that holds a token: the Relay config and the
 * Claude Code channel `.env`. Owner-only by the platform's own means: POSIX
 * mode bits (0o600 file, 0o700 folder) where they exist, and a private Windows
 * ACL (this account, SYSTEM, Administrators) where they do not. Windows has no
 * mode bits, so a chmod there proves nothing and is never used as proof.
 *
 * The write goes through an exclusive temporary file in the same folder that
 * is made private before any secret byte lands in it, then renamed over the
 * destination, then read back to confirm it is still private.
 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

export interface PrivateDestination {
  path: string;
  directory: string;
  windows: boolean;
  /** The descriptor an existing file already had; the new file keeps it exactly. */
  existingACL?: string;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Shared by preflight and the final write: no secret bytes are changed here. */
export const preparePrivateDestination = async (
  path: string,
  what: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PrivateDestination> => {
  const directory = dirname(path);
  const windows = platform === "win32";
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`The ${what} folder is a link or a file, not a folder. Move it aside and sign in again.`);
  if ((directoryInfo.mode & 0o222) === 0) throw new Error(`You do not have permission to write in the ${what} folder.`);
  await access(directory, constants.W_OK);
  if (!windows) await chmod(directory, PRIVATE_DIR_MODE);
  else if (!privateWindowsAcl(await inspectWindowsAcl(directory), true)) {
    throw new Error(`Other Windows accounts can write in the ${what} folder. Limit it to your account; Relay changed nothing.`);
  }
  let existingACL: string | undefined;
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error(`The ${what} file must be a regular file, not a link, and it must not be hard-linked from anywhere else.`);
    if (!windows && (existing.mode & 0o077) !== 0) throw new Error(`Other people on this computer can read the ${what} file. Make it readable by you alone.`);
    if ((existing.mode & 0o444) === 0) throw new Error(`You do not have permission to read the ${what} file.`);
    if ((existing.mode & 0o222) === 0) throw new Error(`You do not have permission to write the ${what} file.`);
    // Opening with r+ proves the operating system allows reading and writing,
    // without emptying the file or writing to it.
    const probe = await open(path, "r+"); await probe.close();
    if (windows) {
      const acl = await inspectWindowsAcl(path);
      if (!privateWindowsAcl(acl)) throw new Error(`Windows permissions on the ${what} file let other accounts read or write it. Limit it to your account before saving a token.`);
      existingACL = acl.sddl;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { path, directory, windows, ...(existingACL === undefined ? {} : { existingACL }) };
};

/** An exclusive, empty, already-private temporary file beside the destination. */
export const openPrivateTemp = async (
  destination: PrivateDestination,
  prefix: string,
): Promise<{ path: string; handle: FileHandle }> => {
  const path = join(destination.directory, `${prefix}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(path, "wx", PRIVATE_FILE_MODE);
  try {
    if (destination.windows) {
      // A file Relay wrote before carries an explicit, protected descriptor and
      // gets it back exactly. A file a person made by hand carries the folder's
      // inherited descriptor, which a new file cannot always take byte for byte
      // (inherited entries are re-derived by Windows), so when the kept
      // descriptor does not come out private the file gets Relay's own.
      let acl = await protectWindowsPath(path, false, destination.existingACL);
      if (!privateWindowsAcl(acl) && destination.existingACL !== undefined) acl = await protectWindowsPath(path, false);
      if (!privateWindowsAcl(acl)) {
        throw new Error(`Relay could not limit the new file to your Windows account, so it did not save the token. (Descriptor: ${acl.sddl})`);
      }
    } else await handle.chmod(PRIVATE_FILE_MODE);
    return { path, handle };
  } catch (error) {
    await handle.close(); await unlink(path); throw error;
  }
};

export const verifyPrivateACL = async (path: string, destination: PrivateDestination): Promise<void> => {
  if (!destination.windows) return;
  const acl = await inspectWindowsAcl(path);
  if (!privateWindowsAcl(acl)) {
    throw new Error(`Relay saved the file but could not confirm that only your Windows account can read it. Check its permissions. (Descriptor: ${acl.sddl})`);
  }
};

export const removeTemp = async (path: string): Promise<void> => {
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
};

/** Writes `contents` to `destination` so no reader ever sees it half-written or readable by anyone else. */
export const writePrivateDestination = async (
  destination: PrivateDestination,
  prefix: string,
  contents: string,
): Promise<void> => {
  const temporary = await openPrivateTemp(destination, prefix);
  try {
    try { await temporary.handle.writeFile(contents, "utf8"); await temporary.handle.sync(); }
    finally { await temporary.handle.close(); }
    await rename(temporary.path, destination.path);
    await verifyPrivateACL(destination.path, destination);
  } finally { await removeTemp(temporary.path); }
};

export interface PrivateFileReport {
  exists: boolean;
  /** Owner-only by the platform's own means; the folder counts too. */
  secure: boolean;
  mode?: number;
  /** Windows only: whether the ACL could be read at all. */
  aclChecked?: boolean;
}

/** How a file and its folder stand today, judged the way this platform judges it. */
export const inspectPrivateFile = async (
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PrivateFileReport> => {
  try {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    if (platform === "win32") {
      try {
        const file = await lstat(path);
        const parent = await lstat(dirname(path));
        const acl = await inspectWindowsAcl(path);
        const parentACL = await inspectWindowsAcl(dirname(path));
        return { exists: true, secure: file.isFile() && !file.isSymbolicLink() && file.nlink === 1
          && parent.isDirectory() && !parent.isSymbolicLink()
          && privateWindowsAcl(acl) && privateWindowsAcl(parentACL, true), mode, aclChecked: true };
      } catch {
        return { exists: true, secure: false, mode, aclChecked: false };
      }
    }
    return { exists: true, secure: (mode & 0o077) === 0, mode };
  } catch (error) {
    if (isMissing(error)) return { exists: false, secure: true };
    throw error;
  }
};
