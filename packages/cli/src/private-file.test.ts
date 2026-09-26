import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { inspectPrivateFile, preparePrivateDestination, writePrivateDestination, writePrivateFile } from "./private-file.js";
import { inspectWindowsAcl, privateWindowsAcl } from "./runtime-connect/windows-acl.js";

/**
 * Owner-only, judged the way the host platform judges it. POSIX has mode bits,
 * so the exact bits are pinned there. Windows has none: `mode & 0o777` reads
 * 0o666 for every file, so the proof there is the real ACL, read back through
 * PowerShell, the same way the Relay config proves itself.
 */
export const expectOwnerOnly = async (path: string, directory?: string): Promise<void> => {
  const report = await inspectPrivateFile(path);
  if (process.platform === "win32") {
    expect(report).toMatchObject({ exists: true, secure: true, aclChecked: true });
    return;
  }
  expect(report).toMatchObject({ exists: true, secure: true });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  if (directory) expect((await stat(directory)).mode & 0o777).toBe(0o700);
};

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), "relay-private-file-"));

it("writes a new file owner-only, in an owner-only folder it creates, and leaves no temporary file", async () => {
  const directory = join(await scratch(), "nested", "deeper");
  const path = join(directory, "secret.txt");
  const destination = await preparePrivateDestination(path, "test");
  await writePrivateDestination(destination, ".test", "token\n");
  expect(await readFile(path, "utf8")).toBe("token\n");
  await expectOwnerOnly(path, directory);
  expect(await readdir(directory)).toEqual(["secret.txt"]);
});

it("replaces a file that is already there and keeps it owner-only", async () => {
  const directory = await scratch();
  const path = join(directory, "secret.txt");
  await writeFile(path, "old\n", { mode: 0o600 });
  const destination = await preparePrivateDestination(path, "test");
  await writePrivateDestination(destination, ".test", "new\n");
  expect(await readFile(path, "utf8")).toBe("new\n");
  await expectOwnerOnly(path, directory);
});

it("reports a file that is not there as absent and safe", async () => {
  expect(await inspectPrivateFile(join(await scratch(), "absent"))).toEqual({ exists: false, secure: true });
});

it.runIf(process.platform !== "win32")("refuses to write over a file other people can read", async () => {
  const directory = await scratch();
  const path = join(directory, "secret.txt");
  await writeFile(path, "old\n", { mode: 0o644 });
  await expect(preparePrivateDestination(path, "test")).rejects.toThrow("Other people on this computer can read the test file");
  expect(await inspectPrivateFile(path)).toMatchObject({ exists: true, secure: false });
});

/** BUILTIN\\Users, the group every local account is in. */
const WINDOWS_USERS = "S-1-5-32-545";

it("writePrivateFile makes an agent's config owner-only in a folder other people can read", async () => {
  const directory = join(await scratch(), "Code", "User");
  await mkdir(directory, { recursive: true });
  if (process.platform === "win32") {
    // The folder lets every local account read, and new files inherit that.
    await promisify(execFile)("icacls", [directory, "/grant", `*${WINDOWS_USERS}:(OI)(CI)(R)`], { windowsHide: true });
    const plain = join(directory, "plain.json");
    await writeFile(plain, "{}\n", { mode: 0o600 });
    // A POSIX mode proves nothing here: the file is readable by Users.
    expect(privateWindowsAcl(await inspectWindowsAcl(plain))).toBe(false);
  } else await chmod(directory, 0o755);
  const path = join(directory, "mcp.json");
  await writePrivateFile(path, "VS Code MCP", '{"servers":{}}\n');
  expect(await readFile(path, "utf8")).toBe('{"servers":{}}\n');
  await expectOwnerOnly(path, directory);
  if (process.platform === "win32") {
    const acl = await inspectWindowsAcl(path);
    expect(acl.rules.map((rule) => rule.sid)).not.toContain(WINDOWS_USERS);
  }
  expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("writePrivateFile refuses, and changes nothing, when other people can already read the file", async () => {
  const directory = await scratch();
  const path = join(directory, "mcp.json");
  await writeFile(path, "{}\n", { mode: 0o644 });
  if (process.platform === "win32") {
    await promisify(execFile)("icacls", [path, "/grant", `*${WINDOWS_USERS}:(R)`], { windowsHide: true });
    await expect(writePrivateFile(path, "VS Code MCP", "token\n")).rejects.toThrow("Windows permissions on the VS Code MCP file let other accounts read or write it");
  } else {
    await expect(writePrivateFile(path, "VS Code MCP", "token\n")).rejects.toThrow("Other people on this computer can read the VS Code MCP file");
  }
  expect(await readFile(path, "utf8")).toBe("{}\n");
});
