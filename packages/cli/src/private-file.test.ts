import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectPrivateFile, preparePrivateDestination, writePrivateDestination } from "./private-file.js";

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
