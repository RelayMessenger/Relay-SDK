import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConsoleApiURL, emptyConfig, readConfig, writeConfig } from "./config.js";
import { consoleLogin, organizationDefaults } from "./console-auth.js";

it("maps staging and production API origins to their Console API origins", () => {
  expect(defaultConsoleApiURL("https://api.staging.relayapp.im")).toBe("https://console.staging.relayapp.im/api");
  expect(defaultConsoleApiURL("https://api.relayapp.im")).toBe("https://console.relayapp.im/api");
});

it("uses a Workspace domain for the organization display default and no random suffix", () => {
  expect(organizationDefaults({ id: "user_1", email: "ada@acme.com", name: "Ada Lovelace" })).toEqual({
    name: "Acme",
    namespace: "acme",
  });
});

it("uses the identity name for public email providers", () => {
  expect(organizationDefaults({ id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" })).toEqual({
    name: "Ada Lovelace",
    namespace: "adalovelace",
  });
});

it("completes device login, bootstraps Personal setup, refreshes the session, and never prints secrets", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "relay-console-device-")));
  const configPath = `${root}/config.json`;
  const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.`;
  const refreshedToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.`;
  const calls: string[] = [];
  let poll = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth/cli/device")) {
      return Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://console.staging.relayapp.im/device",
        expires_in: 60,
        interval: 1,
        client_id: "client_staging",
      });
    }
    if (url.endsWith("/auth/cli/device-code")) {
      poll += 1;
      if (poll === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      if (poll === 2) return Response.json({ error: "slow_down" }, { status: 400 });
      return Response.json({
        access_token: accessToken,
        refresh_token: "refresh-secret",
        user: { id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" },
      });
    }
    if (url.endsWith("/auth/cli/bootstrap")) {
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${accessToken}`,
        "X-Relay-CLI": "1",
      });
      return Response.json({ organization_id: "org_personal", created: true }, { status: 201 });
    }
    if (url === "https://api.workos.com/user_management/authenticate") {
      expect(String(init?.body)).toContain("refresh_token=refresh-secret");
      return Response.json({ access_token: refreshedToken, refresh_token: "refresh-secret" });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const stderr: string[] = [];
  const opened: string[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: never[]) => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);

  const session = await consoleLogin({
    context: { env: { RELAY_CONFIG_PATH: configPath } },
    apiURL: "https://api.staging.relayapp.im",
    fetch,
    openBrowser: async (url) => { opened.push(url); },
    stderr: (value) => stderr.push(value),
    name: "Ada",
    namespace: "ada",
    nonInteractive: true,
  });

  expect(session.organization_id).toBe("org_personal");
  expect(opened).toEqual(["https://console.staging.relayapp.im/device"]);
  expect(calls).toEqual([
    "https://console.staging.relayapp.im/api/auth/cli/device",
    "https://console.staging.relayapp.im/api/auth/cli/device-code",
    "https://console.staging.relayapp.im/api/auth/cli/device-code",
    "https://console.staging.relayapp.im/api/auth/cli/device-code",
    "https://console.staging.relayapp.im/api/auth/cli/bootstrap",
    "https://api.workos.com/user_management/authenticate",
  ]);
  expect(stderr.join("")).toContain("Open https://console.staging.relayapp.im/device");
  expect(stderr.join("")).not.toContain("device-secret");
  expect(stderr.join("")).not.toContain("refresh-secret");
  expect(stderr.join("")).not.toContain(accessToken);
  expect((await readConfig({ env: { RELAY_CONFIG_PATH: configPath } })).console).toMatchObject({
    access_token: refreshedToken,
    refresh_token: "refresh-secret",
    organization_id: "org_personal",
  });
});

it.each([
  ["access_denied", "Relay Console login was denied."],
  ["expired_token", "Relay Console login expired."],
  ["server_error", "Relay Console login failed (HTTP 400)."],
])("reports device login %s without leaking response data", async (oauthError, message) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "relay-console-error-")));
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/auth/cli/device")) {
      return Response.json({
        device_code: "private-device-code",
        user_code: "PRIVATE-CODE",
        verification_uri: "https://console.example.test/device",
        expires_in: 60,
        interval: 1,
        client_id: "client",
      });
    }
    return Response.json({ error: oauthError, error_description: "secret-response-detail" }, { status: 400 });
  });
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: never[]) => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  await expect(consoleLogin({
    context: { env: { RELAY_CONFIG_PATH: `${root}/config.json` } },
    apiURL: "https://api.staging.relayapp.im",
    fetch,
    openBrowser: async () => {},
    stderr: () => {},
  })).rejects.toThrow(message);
  await expect(consoleLogin({
    context: { env: { RELAY_CONFIG_PATH: `${root}/config.json` } },
    apiURL: "https://api.staging.relayapp.im",
    fetch,
    openBrowser: async () => {},
    stderr: () => {},
  })).rejects.not.toThrow("private-device-code");
});

it("reuses the organization returned by Console without bootstrapping it again", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "relay-console-existing-")));
  const configPath = `${root}/config.json`;
  const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.`;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/auth/cli/device")) return Response.json({
      device_code: "device", user_code: "CODE", verification_uri: "https://console.example.test/device",
      expires_in: 60, interval: 1, client_id: "client",
    });
    if (url.endsWith("/auth/cli/device-code")) return Response.json({
      access_token: accessToken, refresh_token: "refresh", organization_id: "org_existing",
      user: { id: "user", email: "ada@gmail.com", name: "Ada" },
    });
    throw new Error(`unexpected request ${url}`);
  });
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: never[]) => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const session = await consoleLogin({
    context: { env: { RELAY_CONFIG_PATH: configPath } }, apiURL: "https://api.staging.relayapp.im",
    fetch, openBrowser: async () => {}, stderr: () => {},
  });
  expect(session.organization_id).toBe("org_existing");
  expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/auth/cli/bootstrap"))).toBe(false);
});

it("round-trips a private Console session without printing or changing agent profiles", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "relay-console-auth-")));
  const configPath = `${root}/config.json`;
  const context = { env: { RELAY_CONFIG_PATH: configPath } };
  const config = emptyConfig();
  config.console = {
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_at: 1,
    client_id: "client_1",
    organization_id: "org_1",
    user: { id: "user_1", email: "ada@acme.com", name: "Ada Lovelace" },
  };
  await writeConfig(config, context);
  const loaded = await readConfig(context);
  expect(loaded.console).toEqual(config.console);
  expect(loaded.profiles).toEqual(config.profiles);
});

afterEach(() => vi.restoreAllMocks());
