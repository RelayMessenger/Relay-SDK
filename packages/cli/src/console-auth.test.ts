import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { defaultAuthURL, defaultConsoleApiURL, emptyConfig, readConfig, writeConfig } from "./config.js";
import { consoleLogin, consoleRequest, consoleSignOut, organizationDefaults } from "./console-auth.js";

const AUTH = "https://auth.staging.relayapp.im";
const CONSOLE = "https://console.staging.relayapp.im/api";

const deviceStart = () => Response.json({
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: `${AUTH}/device`,
  verification_uri_complete: `${AUTH}/device?user_code=ABCD-EFGH`,
  expires_in: 1800,
  interval: 5,
});

const noWait = () => vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: never[]) => void) => {
  callback();
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout);

const scratch = async (prefix: string) => `${await mkdtemp(join(tmpdir(), prefix))}/config.json`;

it("maps staging and production API origins to their Console API origins", () => {
  expect(defaultConsoleApiURL("https://api.staging.relayapp.im")).toBe(CONSOLE);
  expect(defaultConsoleApiURL("https://api.relayapp.im")).toBe("https://console.relayapp.im/api");
});

it("picks Relay-Auth by build, and RELAY_AUTH_URL overrides it", () => {
  expect(defaultAuthURL({}, "1.0.0")).toBe("https://auth.relayapp.im");
  expect(defaultAuthURL({}, "1.0.0-staging.3")).toBe(AUTH);
  expect(defaultAuthURL({ RELAY_AUTH_URL: "http://localhost:3000/" }, "1.0.0")).toBe("http://localhost:3000");
});

it("uses a Workspace domain for the organization display default and no random suffix", () => {
  expect(organizationDefaults({ id: "user_1", email: "ada@acme.com", name: "Ada Lovelace" })).toEqual({
    name: "Acme",
  });
});

it("uses the identity name for public email providers", () => {
  expect(organizationDefaults({ id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" })).toEqual({
    name: "Ada Lovelace",
  });
});

it("completes the Relay-Auth device flow, fills the person from get-session, bootstraps the organization, and never prints secrets", async () => {
  const configPath = await scratch("relay-console-device-");
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let poll = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === `${AUTH}/api/auth/device/code`) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: "relay-cli" });
      return deviceStart();
    }
    if (url === `${AUTH}/api/auth/device/token`) {
      bodies.push(JSON.parse(String(init?.body)));
      poll += 1;
      if (poll === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "session-secret", token_type: "Bearer", expires_in: 2592000, scope: "" });
    }
    if (url === `${AUTH}/api/auth/get-session`) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer session-secret" });
      return Response.json({
        session: { token: "session-secret", expiresAt },
        user: { id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" },
      });
    }
    if (url === `${CONSOLE}/auth/cli/bootstrap`) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer session-secret", "X-Relay-CLI": "1" });
      return Response.json({ organization_id: "org_personal", created: true }, { status: 201 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const stderr: string[] = [];
  const opened: string[] = [];
  noWait();

  const session = await consoleLogin({
    context: { env: { RELAY_CONFIG_PATH: configPath, RELAY_AUTH_URL: AUTH } },
    apiURL: "https://api.staging.relayapp.im",
    fetch,
    openBrowser: async (url) => { opened.push(url); },
    stderr: (value) => stderr.push(value),
    name: "Ada",
    nonInteractive: true,
  });

  expect(session).toEqual({
    access_token: "session-secret",
    expires_at: Date.parse(expiresAt),
    organization_id: "org_personal",
    user: { id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" },
  });
  expect(opened).toEqual([`${AUTH}/device?user_code=ABCD-EFGH`]);
  expect(calls).toEqual([
    `${AUTH}/api/auth/device/code`,
    `${AUTH}/api/auth/device/token`,
    `${AUTH}/api/auth/device/token`,
    `${AUTH}/api/auth/get-session`,
    `${CONSOLE}/auth/cli/bootstrap`,
  ]);
  expect(bodies).toEqual(Array(2).fill({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "device-secret",
    client_id: "relay-cli",
  }));
  const printed = stderr.join("");
  expect(printed).toContain("Your code is ABCD-EFGH");
  expect(printed).toContain(`Open ${AUTH}/device?user_code=ABCD-EFGH`);
  expect(printed).toContain(`If it does not open, enter this code at ${AUTH}/device: ABCD-EFGH`);
  expect(printed).not.toContain("device-secret");
  expect(printed).not.toContain("session-secret");
  expect((await readConfig({ env: { RELAY_CONFIG_PATH: configPath } })).console).toEqual(session);
});

it("polls at the returned interval and adds 5 seconds on slow_down", async () => {
  const configPath = await scratch("relay-console-slow-");
  const waits: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: never[]) => void, ms?: number) => {
    waits.push(ms ?? 0);
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  let poll = 0;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/device/code")) return deviceStart();
    if (url.endsWith("/device/token")) {
      poll += 1;
      if (poll === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      if (poll === 2) return Response.json({ error: "slow_down" }, { status: 400 });
      if (poll === 3) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "session-secret", token_type: "Bearer" });
    }
    if (url.endsWith("/get-session")) return Response.json({ session: { expiresAt: new Date(Date.now() + 1000).toISOString() }, user: { id: "u", email: "u@gmail.com" } });
    if (url.endsWith("/bootstrap")) return Response.json({ organization_id: "org" });
    throw new Error(`unexpected request ${url}`);
  });
  await consoleLogin({
    context: { env: { RELAY_CONFIG_PATH: configPath, RELAY_AUTH_URL: AUTH } },
    apiURL: "https://api.staging.relayapp.im",
    fetch, openBrowser: async () => {}, stderr: () => {}, name: "Org", nonInteractive: true,
  });
  // 5 s, 5 s, then slow_down lifts every later wait to 10 s.
  expect(waits).toEqual([5_000, 5_000, 10_000, 10_000]);
});

it.each([
  ["access_denied", "Relay login was denied."],
  ["expired_token", "Relay login expired."],
  ["invalid_grant", "Relay login failed (HTTP 400)."],
])("stops on device error %s without leaking response data", async (oauthError, message) => {
  const configPath = await scratch("relay-console-error-");
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/device/code")) {
      return Response.json({
        device_code: "private-device-code",
        user_code: "PRIVATE-CODE",
        verification_uri: "https://auth.example.test/device",
        expires_in: 60,
        interval: 1,
      });
    }
    return Response.json({ error: oauthError, error_description: "secret-response-detail" }, { status: 400 });
  });
  noWait();
  const deps = {
    context: { env: { RELAY_CONFIG_PATH: configPath, RELAY_AUTH_URL: AUTH } },
    apiURL: "https://api.staging.relayapp.im",
    fetch,
    openBrowser: async () => {},
    stderr: () => {},
  };
  await expect(consoleLogin(deps)).rejects.toThrow(message);
  await expect(consoleLogin(deps)).rejects.not.toThrow("private-device-code");
  await expect(consoleLogin(deps)).rejects.not.toThrow("secret-response-detail");
  expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/device/token"))).toHaveLength(3);
});

it("treats a stored session from the old flow as signed out", async () => {
  const configPath = await scratch("relay-console-old-");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    current_profile: "default",
    profiles: { default: {} },
    console: {
      access_token: "old-access", refresh_token: "old-refresh", client_id: "client_old",
      expires_at: Date.now() + 3600_000, organization_id: "org_old",
      user: { id: "user", email: "ada@acme.com" },
    },
  }));
  const context = { env: { RELAY_CONFIG_PATH: configPath } };
  expect((await readConfig(context)).console).toBeUndefined();
  const fetch = vi.fn();
  await expect(consoleRequest({ context, fetch }, "/me")).rejects.toThrow("Run relay login.");
  expect(fetch).not.toHaveBeenCalled();
});

it("sends the bearer to every Console call, never refreshes, and asks for relay login once it has expired", async () => {
  const configPath = await scratch("relay-console-bearer-");
  const context = { env: { RELAY_CONFIG_PATH: configPath } };
  const config = emptyConfig();
  config.console = {
    access_token: "session-secret", expires_at: Date.now() + 3600_000, organization_id: "org_1",
    user: { id: "user_1", email: "ada@acme.com" },
  };
  await writeConfig(config, context);
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: "Bearer session-secret", "X-Relay-CLI": "1" });
    return Response.json({ org: { id: "org_1" } });
  });
  expect(await consoleRequest({ context, fetch }, "/me")).toEqual({ org: { id: "org_1" } });
  expect(fetch).toHaveBeenCalledOnce();

  const expired = await readConfig(context);
  expired.console = { ...config.console, expires_at: Date.now() - 1 };
  await writeConfig(expired, context);
  await expect(consoleRequest({ context, fetch }, "/me")).rejects.toThrow("Run relay login.");
  expect(fetch).toHaveBeenCalledOnce();
});

it("signs out at Relay-Auth with the stored bearer", async () => {
  const configPath = await scratch("relay-console-signout-");
  const context = { env: { RELAY_CONFIG_PATH: configPath, RELAY_AUTH_URL: AUTH } };
  const config = emptyConfig();
  config.console = {
    access_token: "session-secret", expires_at: Date.now() + 3600_000,
    user: { id: "user_1", email: "ada@acme.com" },
  };
  await writeConfig(config, context);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(`${AUTH}/api/auth/sign-out`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer session-secret" });
    return Response.json({ success: true });
  });
  expect(await consoleSignOut({ context, fetch })).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

it("round-trips a private Console session without printing or changing agent profiles", async () => {
  const configPath = await scratch("relay-console-auth-");
  const context = { env: { RELAY_CONFIG_PATH: configPath } };
  const config = emptyConfig();
  config.console = {
    access_token: "access-secret",
    expires_at: 1,
    organization_id: "org_1",
    user: { id: "user_1", email: "ada@acme.com", name: "Ada Lovelace" },
  };
  await writeConfig(config, context);
  const loaded = await readConfig(context);
  expect(loaded.console).toEqual(config.console);
  expect(loaded.profiles).toEqual(config.profiles);
});

afterEach(() => vi.restoreAllMocks());
