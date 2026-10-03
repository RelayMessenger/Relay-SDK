import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emptyConfig, writeConfig } from "./config.js";
import { runCLI } from "./program.js";
import { CHECK_INTERVAL_MS, distTagFor, isOutdated, startUpdateCheck, type UpdateCheck } from "./update-check.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const home = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "relay-update-check-"));
  homes.push(dir);
  return dir;
};

const check = (version: string, latest: string | undefined): UpdateCheck =>
  ({ version, tag: distTagFor(version), cached: latest, latest: Promise.resolve(latest) });

async function signedIn() {
  const dir = await home();
  if (process.platform === "win32") {
    const { protectWindowsPath } = await import("./runtime-connect/windows-acl.js");
    await protectWindowsPath(dir, true);
  }
  const configContext = { env: { RELAY_CONFIG_PATH: join(dir, "config.json") }, cwd: dir };
  const config = emptyConfig();
  config.console = {
    access_token: "private-access-fixture",
    expires_at: Date.now() + 3600_000,
    organization_id: "org_fixture",
    user: { id: "user_fixture", email: "fixture@example.invalid" },
  };
  await writeConfig(config, configContext);
  const out: string[] = [], err: string[] = [];
  return { configContext, out, err, stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) };
}

const gone = vi.fn(async () => new Response("<!doctype html><title>Not Found</title>", { status: 404, headers: { "content-type": "text/html" } }));

it("orders versions the way npm does, staging builds below their release", () => {
  expect(isOutdated("0.1.6-staging.46", "0.1.16")).toBe(true);
  expect(isOutdated("0.1.16-staging.5", "0.1.16-staging.6")).toBe(true);
  expect(isOutdated("0.1.16-staging.5", "0.1.16")).toBe(true);
  expect(isOutdated("0.1.16", "0.1.16")).toBe(false);
  expect(isOutdated("0.1.17", "0.1.16")).toBe(false);
  expect(isOutdated("0.1.16", "garbage")).toBe(false);
  expect(distTagFor("0.1.16-staging.5")).toBe("staging");
  expect(distTagFor("0.1.16")).toBe("latest");
});

it("reads the dist-tag once a day, caches it, and never fails offline", async () => {
  const cacheFile = join(await home(), "relay", "update-check.json");
  const fetch = vi.fn(async (input: string | URL | Request) => {
    expect(String(input)).toBe("https://registry.npmjs.org/-/package/relaymessenger/dist-tags");
    return Response.json({ latest: "0.1.16", staging: "0.1.16-staging.5" });
  });
  const now = 1_000_000;
  expect(await startUpdateCheck({ version: "0.1.6", cacheFile, env: {}, fetch, now: () => now }).latest).toBe("0.1.16");
  expect(JSON.parse(await readFile(cacheFile, "utf8"))).toMatchObject({ tag: "latest", latest: "0.1.16" });
  expect(await startUpdateCheck({ version: "0.1.6", cacheFile, env: {}, fetch, now: () => now + 60_000 }).latest).toBe("0.1.16");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await startUpdateCheck({ version: "0.1.6-staging.1", cacheFile, env: {}, fetch, now: () => now }).latest).toBe("0.1.16-staging.5");
  expect(fetch).toHaveBeenCalledTimes(2);

  const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
  await writeFile(cacheFile, JSON.stringify({ tag: "latest", latest: "0.1.16", checked_at: now - CHECK_INTERVAL_MS }));
  expect(await startUpdateCheck({ version: "0.1.6", cacheFile, env: {}, fetch: offline, now: () => now }).latest).toBeUndefined();
  expect(await startUpdateCheck({ version: "0.1.6", cacheFile, env: { NO_UPDATE_NOTIFIER: "1" }, fetch, now: () => now }).latest).toBeUndefined();
});

it("tells a person on an old version what to run, on stderr only", async () => {
  const f = await signedIn();
  const fetch = vi.fn(async () => Response.json({ user: { id: "user_fixture", email: "fixture@example.invalid" }, org: { id: "org_fixture" } }));
  expect(await runCLI(["whoami"], { ...f, fetch, updateCheck: check("0.1.6-staging.46", "0.1.16-staging.5"), fromNpx: false })).toBe(0);
  const err = f.err.join("");
  expect(err).toContain("This relaymessenger is 0.1.6-staging.46, which is out of date. The newest is 0.1.16-staging.5.");
  expect(err).toContain("Run  npx relaymessenger@staging whoami");
  expect(err).toContain("npm uninstall -g relaymessenger");
  expect(f.out.join("")).not.toContain("out of date");

  const json = await signedIn();
  expect(await runCLI(["--json", "whoami"], { ...json, fetch, updateCheck: check("0.1.6", "0.1.16"), fromNpx: false })).toBe(0);
  expect(json.err.join("")).toBe("");
  expect(() => JSON.parse(json.out.join(""))).not.toThrow();

  const current = await signedIn();
  expect(await runCLI(["whoami"], { ...current, fetch, updateCheck: check("0.1.16", "0.1.16") })).toBe(0);
  expect(current.err.join("")).not.toContain("out of date");
});

it("turns a 404 from a route an old version calls into the update instruction", async () => {
  const f = await signedIn();
  expect(await runCLI(["whoami"], { ...f, fetch: gone, updateCheck: check("0.1.6", "0.1.16"), fromNpx: false })).not.toBe(0);
  const err = f.err.join("");
  expect(err).toContain("Relay Console returned HTTP 404.");
  expect(err).toContain("The newest is 0.1.16.");
  expect(err).toContain("Run  npx relaymessenger@latest whoami");
  expect(err).toContain("npm uninstall -g relaymessenger");

  const json = await signedIn();
  await runCLI(["--json", "whoami"], { ...json, fetch: gone, updateCheck: check("0.1.6", "0.1.16"), fromNpx: true });
  const envelope = JSON.parse(json.err.join(""));
  expect(envelope.code).toBe("outdated");
  expect(envelope.error).toContain("Run  npx relaymessenger@latest --json whoami");
  expect(envelope.error).not.toContain("npm uninstall");

  const current = await signedIn();
  await runCLI(["whoami"], { ...current, fetch: gone, updateCheck: check("0.1.16", "0.1.16") });
  expect(current.err.join("")).toBe("Error: Relay Console returned HTTP 404.\n");
});
