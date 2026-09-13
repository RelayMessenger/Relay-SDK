import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectConfiguredTokens, defaultConsoleApiURL, emptyConfig, readConfig, writeConfig,
} from "./config.js";
import { consoleLoginOrReuse, consoleLoginWithKey, consoleRequest } from "./console-auth.js";
import { runCLI } from "./program.js";

const api = defaultConsoleApiURL();
const key = "rel_org_privateTestKey123";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-org-key-"));
  homes.push(home);
  if (process.platform === "win32") {
    const { protectWindowsPath } = await import("./runtime-connect/windows-acl.js");
    await protectWindowsPath(home, true);
  }
  const context = { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home };
  const out: string[] = [], err: string[] = [];
  const fetch = vi.fn(async () => Response.json({ org: { id: "org_fixture" } }));
  const deps = { context, fetch };
  const cli = {
    configContext: context, fetch, isInteractive: false,
    readStdin: async () => `${key}\n`,
    stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value),
  };
  return { home, context, out, err, fetch, deps, cli };
}

it.each(["rel_org_", "rly_org_"])("imports %s keys from stdin without OAuth fields or changing profiles", async (prefix) => {
  const f = await fixture();
  const config = emptyConfig();
  config.profiles.other = { agent_token: "other-private-token" };
  await writeConfig(config, f.context);
  const token = `${prefix}privateTestKey123`;
  expect(await runCLI(["--json", "--no-input", "login", "--with-token"], {
    ...f.cli, readStdin: async () => ` ${token}\n`,
  })).toBe(0);
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${api}/me`, {
    headers: { Authorization: `Bearer ${token}`, "X-Relay-CLI": "1" },
  });
  const saved = await readConfig(f.context);
  expect(saved.profiles).toEqual(config.profiles);
  expect(saved.console).toEqual({
    type: "organization_key", organization_key: token,
    organization_id: "org_fixture", console_api_url: api,
  });
  expect(JSON.parse(f.out.join(""))).toEqual({
    ok: true, type: "organization_key", organization_id: "org_fixture", token: "stored",
  });
  expect(f.out.join("") + f.err.join("")).not.toContain(token);
  expect(await collectConfiguredTokens(f.context)).toContain(token);
  if (process.platform !== "win32") expect((await stat(f.context.env.RELAY_CONFIG_PATH)).mode & 0o777).toBe(0o600);
});

it.each(["", "agent-private-token", "rel_org_", "rel_org_one\nrel_org_two", "rel_org_bad\u0000"])("rejects invalid stdin %j before requests", async (raw) => {
  const f = await fixture();
  expect(await runCLI(["--json", "--no-input", "login", "--with-token"], {
    ...f.cli, readStdin: async () => raw,
  })).not.toBe(0);
  expect(f.fetch).not.toHaveBeenCalled();
  expect((await readConfig(f.context)).console).toBeUndefined();
});

it("never accepts a key as an argument or prints rejected arguments", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "login", "--with-token", key], f.cli)).toBe(2);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.out.join("") + f.err.join("")).not.toContain(key);
});

it.each([401, 403, 500])("failed validation HTTP %s preserves existing OAuth and profile bytes", async (status) => {
  const f = await fixture();
  const config = emptyConfig();
  config.console = {
    access_token: "private-access", refresh_token: "private-refresh", client_id: "client",
    expires_at: Date.now() + 3600_000, organization_id: "old_org",
    user: { id: "user", email: "owner@example.invalid" },
  };
  await writeConfig(config, f.context);
  const before = await readFile(f.context.env.RELAY_CONFIG_PATH, "utf8");
  const fetch = vi.fn(async () => Response.json({ error: key }, { status }));
  expect(await runCLI(["--json", "--no-input", "login", "--with-token"], { ...f.cli, fetch })).not.toBe(0);
  expect(await readFile(f.context.env.RELAY_CONFIG_PATH, "utf8")).toBe(before);
  expect(fetch).toHaveBeenCalledOnce();
  expect(f.err.join("")).not.toContain(key);
});

it.each([{}, { user: { id: "user" } }, { org: { id: "" } }])("rejects incomplete /me before persistence", async (body) => {
  const f = await fixture();
  await expect(consoleLoginWithKey({ ...f.deps, fetch: async () => Response.json(body) }, key)).rejects.toThrow("Nothing was changed");
  expect((await readConfig(f.context)).console).toBeUndefined();
});

it("redacts a network failure before the key has been saved", async () => {
  const f = await fixture();
  await expect(consoleLoginWithKey({ ...f.deps, fetch: async () => { throw new Error(`network ${key}`); } }, key)).rejects.not.toThrow(key);
});

it.each([401, 403, 500])("saved key rejection HTTP %s never refreshes or falls back to OAuth", async (status) => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const fetch = vi.fn(async () => Response.json({ error: key }, { status }));
  const openBrowser = vi.fn();
  await expect(consoleLoginOrReuse({ context: f.context, fetch, openBrowser })).rejects.toThrow(`HTTP ${status}`);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(`${api}/me`);
  expect(openBrowser).not.toHaveBeenCalled();
  expect((await readConfig(f.context)).console?.type).toBe("organization_key");
});

it("key reuse sends the actual key, retains the org identity, and redacts response metadata", async () => {
  const f = await fixture();
  const session = await consoleLoginWithKey(f.deps, key);
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
    return Response.json({ org: { id: "org_fixture" }, unsafe: key });
  });
  expect(await consoleLoginOrReuse({ context: f.context, fetch })).toEqual(session);
  expect(await consoleRequest({ context: f.context, fetch }, "/me")).toMatchObject({ unsafe: "[REDACTED]" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([["login"], ["whoami"], ["agents", "create", "--name", "Rejected"]])(
  "revoked key command %j fails without device login or mutation",
  async (...args) => {
    const f = await fixture();
    await consoleLoginWithKey(f.deps, key);
    const fetch = vi.fn(async () => Response.json({ error: key }, { status: 401 }));
    expect(await runCLI(["--json", "--no-input", ...args], { ...f.cli, fetch })).not.toBe(0);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${api}/me`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }));
    expect(f.err.join("")).not.toContain(key);
    expect(Object.values((await readConfig(f.context)).profiles).every(p => !p.agent_token)).toBe(true);
  },
);

it.each([true, false])("OAuth refresh stays functional (expired=%s)", async (expired) => {
  const f = await fixture();
  const config = emptyConfig();
  config.console = {
    access_token: "old-access", refresh_token: "old-refresh", client_id: "client_fixture",
    expires_at: expired ? 0 : Date.now() + 3600_000,
    organization_id: "org_fixture", user: { id: "user", email: "user@example.invalid" },
  };
  await writeConfig(config, f.context);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://api.workos.com/user_management/authenticate") {
      expect(String(init?.body)).toContain("refresh_token=old-refresh");
      return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
    }
    return new Headers(init?.headers).get("authorization") === "Bearer fresh-access"
      ? Response.json({ org: { id: "org_fixture" } })
      : Response.json({ error: "expired" }, { status: 401 });
  });
  expect(await consoleLoginOrReuse({ context: f.context, fetch })).toMatchObject({
    access_token: "fresh-access", refresh_token: "fresh-refresh",
  });
  expect(fetch).toHaveBeenCalledTimes(expired ? 2 : 3);
});

it.each([401, 403, 500])("Console deletion HTTP %s keeps profile and never tries SDK deletion", async (status) => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const config = await readConfig(f.context);
  config.profiles.test = { agent_token: "agent-private-token" };
  await writeConfig(config, f.context);
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url === `${api}/me`) return Response.json({ org: { id: "org_fixture" } });
    if (url === `${api}/orgs/org_fixture/agents`) return Response.json([{ id: "uuid_fixture", handle: "test.fixture" }]);
    if (url.endsWith("/v1/contact_card")) return Response.json({ contact_cards: [{ handle: "test.fixture", kind: "agent" }] });
    expect(init?.method).toBe("DELETE");
    return Response.json({ error: key }, { status });
  });
  expect(await runCLI(["--json", "--no-input", "--profile", "test", "agents", "delete", "test.fixture"], { ...f.cli, fetch })).not.toBe(0);
  expect(calls.filter(url => url.startsWith(api))).toEqual([`${api}/me`, `${api}/orgs/org_fixture/agents`, `${api}/orgs/org_fixture/agents/uuid_fixture`]);
  expect((await readConfig(f.context)).profiles.test?.agent_token).toBe("agent-private-token");
});

it("Console delete never clears a different explicitly selected agent", async () => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const config = await readConfig(f.context);
  config.profiles.other = { agent_token: "other-agent-token" };
  await writeConfig(config, f.context);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).not.toBe("DELETE");
    if (String(input).endsWith("/me")) return Response.json({ org: { id: "org_fixture" } });
    if (String(input).endsWith("/agents")) return Response.json([{ id: "uuid_fixture", handle: "target.fixture" }]);
    return Response.json({ contact_cards: [{ kind: "agent", handle: "other.fixture" }] });
  });
  expect(await runCLI(["--json", "--no-input", "--profile", "other", "agents", "delete", "target.fixture"], { ...f.cli, fetch })).not.toBe(0);
  expect((await readConfig(f.context)).profiles.other?.agent_token).toBe("other-agent-token");
});

it("does not send a saved key to a different Console", async () => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const fetch = vi.fn();
  await expect(consoleRequest({
    context: { ...f.context, env: { ...f.context.env, RELAY_CONSOLE_API_URL: "https://another.example/api" } }, fetch,
  }, "/me")).rejects.toThrow("different Console");
  expect(fetch).not.toHaveBeenCalled();
});

it("malformed saved key mode fails closed instead of silently becoming OAuth", async () => {
  const f = await fixture();
  await writeFile(f.context.env.RELAY_CONFIG_PATH, JSON.stringify({
    ...emptyConfig(), console: { type: "organization_key", organization_key: key },
  }));
  await expect(consoleLoginOrReuse(f.deps)).rejects.toThrow("incomplete");
  expect(f.fetch).not.toHaveBeenCalled();
});

it("whoami reports the organization, not the key creator or an implicit agent", async () => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const config = await readConfig(f.context);
  config.profiles.default!.agent_token = "agent-private-token";
  await writeConfig(config, f.context);
  const fetch = vi.fn(async () => Response.json({
    user: { id: "creator", email: "creator@example.invalid" }, org: { id: "org_fixture" }, secret: key,
  }));
  expect(await runCLI(["--json", "--no-input", "whoami"], { ...f.cli, fetch })).toBe(0);
  expect(JSON.parse(f.out.join(""))).toEqual({ type: "organization_key", organization_id: "org_fixture" });
  f.out.length = 0;
  expect(await runCLI(["--json", "--no-input", "--profile", "default", "whoami"], f.cli)).toBe(0);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ profile: "default", token_source: "profile" });
  expect(f.out.join("") + f.err.join("")).not.toContain(key);
});

it("logout removes only selected agent credentials and key; hidden auth logout leaves the key", async () => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const config = await readConfig(f.context);
  config.profiles.default!.agent_token = "selected-token";
  config.profiles.other = { agent_token: "unrelated-token" };
  await writeConfig(config, f.context);
  expect(await runCLI(["--json", "--no-input", "auth", "logout"], f.cli)).toBe(0);
  expect((await readConfig(f.context)).console?.type).toBe("organization_key");
  expect(await runCLI(["--json", "--no-input", "logout"], f.cli)).toBe(0);
  const saved = await readConfig(f.context);
  expect(saved.console).toBeUndefined();
  expect(saved.profiles.other?.agent_token).toBe("unrelated-token");
  expect(f.out.join("") + f.err.join("")).not.toContain(key);
});

it.each(["fixture", "n".repeat(60)])("headless key create → local list → Console UUID delete (namespace %s)", async (namespace) => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const calls: Array<{ url: string; method: string; bearer: string | null }> = [];
  const handle = `cli_test.${namespace}`;
  const card = { handle, first_name: "CLI Test", image_url: null, kind: "agent", is_active: true };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    calls.push({ url, method, bearer: new Headers(init?.headers).get("authorization") });
    if (url === `${api}/me`) return Response.json({ org: { id: "org_fixture", handleNamespace: namespace } });
    if (url === `${api}/orgs/org_fixture/agents` && method === "POST") {
      expect(JSON.parse(String(init?.body))).toMatchObject({ handle, displayName: "CLI Test" });
      return Response.json({ agent: { id: "agent-uuid", handle, displayName: "CLI Test", avatarUrl: null }, token: "created-agent-token" }, { status: 201 });
    }
    if (url === `${api}/orgs/org_fixture/agents`) return Response.json([{ id: "agent-uuid", handle }]);
    if (url === `${api}/orgs/org_fixture/agents/agent-uuid` && method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/v1/contact_card")) return Response.json({ contact_cards: [card] });
    throw new Error(`unexpected fixture request ${method} ${url}`);
  });
  expect(await runCLI(["--json", "--no-input", "agents", "create", "--name", "CLI Test", "--handle", "cli_test"], { ...f.cli, fetch }), f.err.join("")).toBe(0);
  const created = JSON.parse(f.out.pop()!);
  expect(created).toMatchObject({ handle, display_name: "CLI Test", image_url: null, organization_id: "org_fixture", token: "stored" });
  expect(created.profile.length).toBeLessThanOrEqual(64);
  expect(await runCLI(["--json", "--no-input", "agents", "list"], { ...f.cli, fetch }), f.err.join("")).toBe(0);
  expect(JSON.parse(f.out.pop()!).agents).toHaveLength(1);
  expect(await runCLI(["--json", "--no-input", "agents", "delete", handle], { ...f.cli, fetch })).toBe(0);
  expect(calls.filter((call) => call.method === "DELETE")).toEqual([{
    url: `${api}/orgs/org_fixture/agents/agent-uuid`, method: "DELETE", bearer: `Bearer ${key}`,
  }]);
  expect(await runCLI(["--json", "--no-input", "agents", "list"], { ...f.cli, fetch })).toBe(0);
  expect(JSON.parse(f.out.pop()!).agents).toEqual([]);
  const saved = await readConfig(f.context);
  expect(saved.profiles[created.profile]?.agent_token).toBeUndefined();
  expect(saved.console?.type).toBe("organization_key");
  expect(f.out.join("") + f.err.join("")).not.toContain(key);
  expect(f.out.join("") + f.err.join("")).not.toContain("created-agent-token");
});

it.each([undefined, "requested"])("Console create preserves profile naming and collisions (explicit %s)", async (requested) => {
  const f = await fixture();
  await consoleLoginWithKey(f.deps, key);
  const config = await readConfig(f.context);
  const handle = `cli_test.${"n".repeat(60)}`;
  config.profiles[handle.slice(0, 64)] = { agent_token: "unrelated-token" };
  await writeConfig(config, f.context);
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json({ agent: { handle, displayName: "CLI Test", avatarUrl: null }, token: "created-token" })
      : Response.json({ org: { id: "org_fixture", handleNamespace: "n".repeat(60) } }));
  const args = ["--json", "--no-input", ...(requested ? ["--profile", requested] : []), "agents", "create"];
  expect(await runCLI(args, { ...f.cli, fetch })).toBe(0);
  const saved = await readConfig(f.context);
  expect(saved.profiles[handle.slice(0, 64)]?.agent_token).toBe("unrelated-token");
  const created = JSON.parse(f.out.pop()!);
  expect(created.profile).toBe(requested ?? `${handle.slice(0, 54)}-2`);
  expect(saved.profiles[created.profile]?.agent_token).toBe("created-token");
  if (requested) {
    fetch.mockClear();
    expect(await runCLI(args, { ...f.cli, fetch })).not.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  }
});
