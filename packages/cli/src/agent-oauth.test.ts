import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConsoleApiURL, emptyConfig, writeConfig } from "./config.js";
import { runCLI } from "./program.js";

/**
 * `relay oauth`: a stand-in for Relay Console's OAuth2 routes
 * (Relay-Console apps/api/src/routes/agents.ts: GET and PATCH
 * /orgs/:orgId/agents/:id/oauth2, POST .../oauth2/reset-secret). The first
 * read makes the client and carries the secret once.
 */
const api = defaultConsoleApiURL();
const bearer = "console-session-bearer-0123456789";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-oauth-"));
  homes.push(home);
  const context = { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home };
  const config = emptyConfig();
  config.console = {
    access_token: bearer, expires_at: Date.now() + 60_000, organization_id: "org_a",
    user: { id: "owner-user", email: "owner@example.com" },
  };
  await writeConfig(config, context);
  const client = { client_id: "agent-uuid", redirect_uris: [] as string[], scopes: ["openid", "profile"], created_at: "", updated_at: "" };
  let made = false;
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.slice(new URL(api).pathname.length);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (path === "/me") return Response.json({ org: { id: "org_a" } });
    if (path === "/orgs/org_a/agents") return Response.json([{ id: "agent-uuid", handle: "weather" }]);
    const base = "/orgs/org_a/agents/agent-uuid/oauth2";
    if (path === base && method === "GET") {
      const first = !made;
      made = true;
      return Response.json({ client, ...(first ? { client_secret: "rel_cs_first" } : {}) });
    }
    if (path === base && method === "PATCH") {
      Object.assign(client, body);
      return Response.json({ client });
    }
    if (path === `${base}/reset-secret` && method === "POST") return Response.json({ client, client_secret: "rel_cs_new" });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const out: string[] = [], err: string[] = [];
  const cli = { configContext: context, fetch, isInteractive: false, stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value) };
  const run = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    const code = await runCLI(["--json", "--no-input", ...args], cli);
    return { code, out: out.join("") ? JSON.parse(out.join("")) as Record<string, unknown> : undefined, err: err.join("") ? JSON.parse(err.join("")) as Record<string, unknown> : undefined };
  };
  return { run, calls, client };
}

it("shows the client, with the secret only on the read that made it", async () => {
  const f = await fixture();
  expect((await f.run("oauth", "show", "@Weather")).out).toEqual({
    handle: "weather", client_id: "agent-uuid", redirect_uris: [], scopes: ["openid", "profile"], client_secret: "rel_cs_first",
  });
  expect((await f.run("oauth", "show", "weather")).out).not.toHaveProperty("client_secret");
});

it("adds and removes redirects, sets the optional scopes, and resets the secret", async () => {
  const f = await fixture();
  await f.run("oauth", "redirects", "add", "weather", "https://example.com/cb");
  expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", body: { redirect_uris: ["https://example.com/cb"] } });
  await f.run("oauth", "redirects", "add", "weather", "https://example.com/two");
  expect(f.client.redirect_uris).toEqual(["https://example.com/cb", "https://example.com/two"]);
  await f.run("oauth", "redirects", "remove", "weather", "https://example.com/cb");
  expect(f.client.redirect_uris).toEqual(["https://example.com/two"]);
  const missing = await f.run("oauth", "redirects", "remove", "weather", "https://nope.example");
  expect(missing.code).not.toBe(0);
  await f.run("oauth", "scopes", "weather", "email", "phone");
  expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", body: { scopes: ["openid", "profile", "email", "phone"] } });
  expect((await f.run("oauth", "scopes", "weather", "address")).code).not.toBe(0);
  expect((await f.run("oauth", "reset-secret", "weather")).out).toMatchObject({ client_secret: "rel_cs_new" });
  expect(f.calls.at(-1)).toMatchObject({ method: "POST", path: "/orgs/org_a/agents/agent-uuid/oauth2/reset-secret" });
});
