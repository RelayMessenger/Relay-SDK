import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emptyConfig, readConfig, writeConfig } from "./config.js";
import { runCLI } from "./program.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-console-commands-"));
  homes.push(home);
  if (process.platform === "win32") {
    const { protectWindowsPath } = await import("./runtime-connect/windows-acl.js");
    await protectWindowsPath(home, true);
  }
  const configContext = { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home };
  const config = emptyConfig();
  config.console = {
    access_token: "private-access-fixture",
    expires_at: Date.now() + 3600_000,
    organization_id: "org_fixture",
    user: { id: "user_fixture", email: "fixture@example.invalid" },
  };
  await writeConfig(config, configContext);
  const out: string[] = [], err: string[] = [];
  const signOut = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.pathname).toBe("/api/auth/sign-out");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-access-fixture");
    return Response.json({ success: true });
  });
  return {
    configContext, config, out, err, signOut,
    dependencies: {
      configContext,
      fetch: signOut,
      stdout: (value: string) => out.push(value),
      stderr: (value: string) => err.push(value),
    },
  };
}

it("whoami reports a Console-only login without requiring an Agent Token", async () => {
  const f = await fixture();
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer private-access-fixture",
      "X-Relay-CLI": "1",
    });
    return Response.json({
      user: { id: "user_fixture", email: "fixture@example.invalid", name: "Fixture" },
      org: { id: "org_fixture" },
    });
  });
  expect(await runCLI(["--json", "--no-input", "whoami"], { ...f.dependencies, fetch })).toBe(0);
  expect(JSON.parse(f.out.join(""))).toEqual({
    user: { id: "user_fixture", email: "fixture@example.invalid", name: "Fixture" },
    organization_id: "org_fixture",
  });
  expect(f.out.join("") + f.err.join("")).not.toContain("private-access-fixture");
  expect(f.out.join("") + f.err.join("")).not.toContain("private-refresh-fixture");
  expect(fetch).toHaveBeenCalledOnce();
});

it("logout clears a Console-only session", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "--no-input", "logout"], f.dependencies)).toBe(0);
  expect((await readConfig(f.configContext)).console).toBeUndefined();
  expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true, console: "removed" });
  expect(f.signOut).toHaveBeenCalledOnce();
});

it("logout clears the selected token and Console session but preserves other profiles", async () => {
  const f = await fixture();
  const config = await readConfig(f.configContext);
  config.profiles.default!.agent_token = "selected-token";
  config.profiles.other = { agent_token: "other-token", api_url: "https://api.staging.relayapp.im" };
  await writeConfig(config, f.configContext);
  expect(await runCLI(["--json", "--no-input", "logout"], f.dependencies)).toBe(0);
  const saved = await readConfig(f.configContext);
  expect(saved.console).toBeUndefined();
  expect(saved.profiles.default?.agent_token).toBeUndefined();
  expect(saved.profiles.other?.agent_token).toBe("other-token");
  expect(f.signOut).toHaveBeenCalledOnce();
});

it("hidden auth logout remains an agent-token-only operation", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "--no-input", "auth", "logout"], f.dependencies)).toBe(0);
  expect((await readConfig(f.configContext)).console).toMatchObject({ access_token: "private-access-fixture" });
});

it("an explicitly selected empty agent profile does not silently become a Console identity", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "--no-input", "--profile", "default", "whoami"], f.dependencies)).toBe(4);
  expect(f.out.join("")).toBe("");
});
