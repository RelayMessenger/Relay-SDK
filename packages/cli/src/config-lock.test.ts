import { mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mutateConfig } from "./config.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const realFS = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const denied = () => Object.assign(new Error("owned lock fixture permission failure"), { code: "EPERM" });
beforeEach(() => { vi.mocked(open).mockReset().mockImplementation(realFS.open); });
afterEach(() => { vi.restoreAllMocks(); });
async function fixture(platform: NodeJS.Platform = "win32") {
  const home = await mkdtemp(join(tmpdir(), "relay-lock-regression-"));
  return { home, platform, env: { RELAY_CONFIG_PATH: join(home, "config.json") } };
}

it("retries transient Windows EPERM and EEXIST but runs the transaction only after exclusive ownership", async () => {
  const ctx = await fixture(); let acquired = false;
  vi.mocked(open).mockRejectedValueOnce(denied())
    .mockRejectedValueOnce(Object.assign(new Error("held"), { code: "EEXIST" }))
    .mockRejectedValueOnce(denied())
    .mockImplementation(async (...args) => { const handle = await realFS.open(...args); acquired = true; return handle; });
  const change = vi.fn(() => { expect(acquired).toBe(true); return "done"; });
  expect(await mutateConfig(change, ctx)).toBe("done");
  expect(change).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledTimes(4);
  for (const args of vi.mocked(open).mock.calls) expect(args).toEqual([`${ctx.env.RELAY_CONFIG_PATH}.lock`, "wx", 0o600]);
  expect(await readdir(ctx.home)).toEqual([]);
});

it("bounds persistent Windows EPERM without entering the transaction or changing permissions", async () => {
  const ctx = await fixture(); const error = denied(); const change = vi.fn();
  vi.mocked(open).mockRejectedValue(error);
  await expect(mutateConfig(change, ctx)).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(11); expect(change).not.toHaveBeenCalled();
  expect(await readdir(ctx.home)).toEqual([]);
});

it.each([["linux", "EPERM"], ["win32", "EACCES"]] as const)("does not retry %s %s", async (platform, code) => {
  const ctx = await fixture(platform); const error = Object.assign(new Error("not transient"), { code });
  const change = vi.fn(); vi.mocked(open).mockRejectedValue(error);
  await expect(mutateConfig(change, ctx)).rejects.toBe(error);
  expect(open).toHaveBeenCalledOnce(); expect(change).not.toHaveBeenCalled();
});

it("never removes an existing owner's lock when the busy deadline expires", async () => {
  const ctx = await fixture(); const path = `${ctx.env.RELAY_CONFIG_PATH}.lock`;
  await writeFile(path, "other owned fixture");
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(120_001);
  const change = vi.fn();
  await expect(mutateConfig(change, ctx)).rejects.toThrow("configuration is busy");
  expect(change).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe("other owned fixture");
});

it("releases its own acquired lock even when the transaction throws", async () => {
  const ctx = await fixture(); const error = new Error("transaction failed");
  await expect(mutateConfig(() => { throw error; }, ctx)).rejects.toBe(error);
  expect(open).toHaveBeenCalledOnce(); expect(await readdir(ctx.home)).toEqual([]);
});
