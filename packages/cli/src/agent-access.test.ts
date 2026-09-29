import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConsoleApiURL, emptyConfig, writeConfig } from "./config.js";
import { runCLI } from "./program.js";

/**
 * A stand-in for Relay Console's agent routes with Relay Server's list rules
 * (Relay-Console apps/api/src/routes/agents.ts; Relay-Server agent-access.ts):
 * one row per contact, so a PUT with the other rule moves it; 404 for an
 * unknown handle; 409 for the agent itself, or its owner on Never Allow.
 */
const api = defaultConsoleApiURL();
const bearer = "console-session-bearer-0123456789";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const card = (handle: string, kind: "user" | "agent") => ({
  id: `id-${handle}`, handle, display_name: handle.toUpperCase(), kind,
  image_url: null, image_color: null, verified: false,
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-access-"));
  homes.push(home);
  const context = { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home };
  const config = emptyConfig();
  config.console = {
    access_token: bearer, expires_at: Date.now() + 60_000, organization_id: "org_a",
    user: { id: "owner-user", email: "owner@example.com" },
  };
  await writeConfig(config, context);
  const agent = { id: "agent-uuid", handle: "weather", people_can_message: true, agents_can_message: "everyone" as string };
  const contacts = new Map([["alice", card("alice", "user")], ["outside_bot", card("outside_bot", "agent")], ["owner", card("owner", "user")], ["weather", card("weather", "agent")]]);
  const rules = new Map<string, "allow" | "deny">();
  const calls: Array<{ method: string; path: string; body?: unknown; auth: string | null }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.slice(new URL(api).pathname.length);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, ...(body ? { body } : {}), auth: new Headers(init?.headers).get("authorization") });
    if (path === "/me") return Response.json({ org: { id: "org_a" } });
    if (path === "/orgs/org_a/agents") return Response.json([{ id: "other-uuid", handle: "news" }, { id: agent.id, handle: agent.handle }]);
    const base = `/orgs/org_a/agents/${agent.id}`;
    if (path === base && method === "GET") return Response.json({ id: agent.id, handle: agent.handle, displayName: "Weather", people_can_message: agent.people_can_message, agents_can_message: agent.agents_can_message, configurationRevision: "3" });
    if (path === base && method === "PATCH") {
      if (body && "people_can_message" in body) agent.people_can_message = body.people_can_message as boolean;
      if (body && "agents_can_message" in body) agent.agents_can_message = body.agents_can_message as string;
      return Response.json({ id: agent.id, handle: agent.handle, people_can_message: agent.people_can_message, agents_can_message: agent.agents_can_message });
    }
    if (path === `${base}/access` && method === "GET") {
      const list = (rule: "allow" | "deny") => [...rules].filter(([, value]) => value === rule).map(([handle]) => contacts.get(handle));
      return Response.json({ allow: list("allow"), deny: list("deny") });
    }
    const subject = decodeURIComponent(path.slice(`${base}/access/`.length));
    if (path.startsWith(`${base}/access/`) && method === "PUT") {
      const contact = contacts.get(subject);
      if (!contact) return Response.json({ error: "Contact was not found.", code: "2001" }, { status: 404 });
      const rule = (body as { rule: "allow" | "deny" }).rule;
      if (subject === "weather" || (subject === "owner" && rule === "deny")) {
        return Response.json({ error: "You can't add that contact to this list.", code: "2032" }, { status: 409 });
      }
      rules.set(subject, rule);
      return Response.json({ rule, contact });
    }
    if (path.startsWith(`${base}/access/`) && method === "DELETE") {
      if (!rules.delete(subject)) return Response.json({ error: "Contact was not found.", code: "2001" }, { status: 404 });
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const out: string[] = [], err: string[] = [];
  const cli = { configContext: context, fetch, isInteractive: false, stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value) };
  const run = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    const code = await runCLI(["--json", "--no-input", ...args], cli);
    return { code, out: out.join("") ? JSON.parse(out.join("")) as Record<string, unknown> : undefined, err: err.join("") ? JSON.parse(err.join("")) as Record<string, unknown> : undefined };
  };
  return { run, calls, agent, rules, fetch, out, err };
}

it("shows Available to and both lists for an organization's agent, with the Console session", async () => {
  const f = await fixture();
  f.rules.set("alice", "allow");
  f.rules.set("outside_bot", "deny");
  const shown = await f.run("agents", "access", "show", "weather");
  expect(shown.code).toBe(0);
  expect(shown.out).toEqual({
    handle: "weather", available_to: "Open", people_can_message: true, agents_can_message: "everyone",
    allow: [{ handle: "alice", display_name: "ALICE", kind: "user" }],
    deny: [{ handle: "outside_bot", display_name: "OUTSIDE_BOT", kind: "agent" }],
  });
  expect(f.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "GET /me", "GET /orgs/org_a/agents", "GET /orgs/org_a/agents/agent-uuid", "GET /orgs/org_a/agents/agent-uuid/access",
  ]);
  expect(f.calls.every((call) => call.auth === `Bearer ${bearer}`)).toBe(true);
  expect(JSON.stringify(shown)).not.toContain(bearer);
});

it("makes an agent private with the two existing settings, sending only what was named", async () => {
  const f = await fixture();
  const updated = await f.run("agents", "access", "update", "@Weather", "--people", "off", "--agents", "nobody");
  expect(updated).toMatchObject({ code: 0, out: { handle: "weather", people_can_message: false, agents_can_message: "nobody" } });
  expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/orgs/org_a/agents/agent-uuid", body: { people_can_message: false, agents_can_message: "nobody" } });
  await f.run("agents", "access", "update", "weather", "--agents", "communities");
  expect(f.calls.at(-1)?.body).toEqual({ agents_can_message: "communities" });
  await f.run("agents", "access", "update", "weather", "--people", "on");
  expect(f.calls.at(-1)?.body).toEqual({ people_can_message: true });
  expect(f.agent).toMatchObject({ people_can_message: true, agents_can_message: "communities" });
});

it("private turns people off and other agents to nobody, through the same Console route update uses", async () => {
  const f = await fixture();
  f.rules.set("alice", "allow");
  const made = await f.run("agents", "access", "private", "@Weather");
  expect(made).toEqual({ code: 0, err: undefined, out: { handle: "weather", available_to: "Private", people_can_message: false, agents_can_message: "nobody" } });
  expect(f.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "GET /me", "GET /orgs/org_a/agents", "PATCH /orgs/org_a/agents/agent-uuid",
  ]);
  expect(f.calls.at(-1)?.body).toEqual({ people_can_message: false, agents_can_message: "nobody" });
  // Always Allow is untouched: private keeps the handles the owner chose.
  expect(f.rules.get("alice")).toBe("allow");
  expect((await f.run("agents", "access", "show", "weather")).out).toMatchObject({
    available_to: "Private", people_can_message: false, agents_can_message: "nobody",
    allow: [{ handle: "alice" }],
  });
});

it("open turns people on and other agents to everyone, the default", async () => {
  const f = await fixture();
  f.agent.people_can_message = false;
  f.agent.agents_can_message = "nobody";
  const opened = await f.run("agents", "access", "open", "weather");
  expect(opened.out).toEqual({ handle: "weather", available_to: "Open", people_can_message: true, agents_can_message: "everyone" });
  expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/orgs/org_a/agents/agent-uuid", body: { people_can_message: true, agents_can_message: "everyone" } });
  expect(f.agent).toMatchObject({ people_can_message: true, agents_can_message: "everyone" });
});

it.each([
  [false, "everyone"],
  [true, "nobody"],
  [true, "communities"],
  [false, "communities"],
] as const)("show names neither Private nor Open for people %s and agents %s, and prints the two settings", async (people, agents) => {
  const f = await fixture();
  f.agent.people_can_message = people;
  f.agent.agents_can_message = agents;
  const shown = await f.run("agents", "access", "show", "weather");
  expect(shown.out).toEqual({ handle: "weather", people_can_message: people, agents_can_message: agents, allow: [], deny: [] });
  expect(shown.out).not.toHaveProperty("available_to");
});

it("help names private and open, keeps the organization line, and no longer says there is no private mode", async () => {
  const out: string[] = [];
  const home = await mkdtemp(join(tmpdir(), "relay-access-help-"));
  homes.push(home);
  for (const args of [["agents", "access", "--help"], ["agents", "access", "private", "--help"], ["agents", "access", "open", "--help"]]) {
    out.length = 0;
    await runCLI(args, {
      configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home },
      fetch: vi.fn(), isInteractive: false, stdout: (value) => out.push(value), stderr: (value) => out.push(value),
    });
    const help = out.join("");
    expect(help).toContain("People in your organization can always message the agent");
    expect(help).toContain("relay agents access private weather");
    expect(help).toContain("relay agents access open weather");
    expect(help).not.toMatch(/no private mode/iu);
  }
});

it.each([
  [["--people", "maybe"]],
  [["--agents", "friends"]],
  [[]],
])("refuses %j before any Console request", async (flags) => {
  const f = await fixture();
  const refused = await f.run("agents", "access", "update", "weather", ...flags);
  expect(refused.code).toBe(2);
  expect(f.calls.filter((call) => call.method === "PATCH")).toEqual([]);
});

it("puts a handle on Always Allow, moves it to Never Allow, and removes it, as the Console's handle field does", async () => {
  const f = await fixture();
  expect(await f.run("agents", "access", "allow", "weather", " @Outside_Bot ")).toMatchObject({
    code: 0, out: { ok: true, handle: "weather", rule: "allow", contact: { handle: "outside_bot", kind: "agent" } },
  });
  expect(f.calls.at(-1)).toMatchObject({ method: "PUT", path: "/orgs/org_a/agents/agent-uuid/access/outside_bot", body: { rule: "allow" } });
  expect(f.rules.get("outside_bot")).toBe("allow");
  expect(await f.run("agents", "access", "deny", "weather", "outside_bot")).toMatchObject({ code: 0, out: { rule: "deny" } });
  expect(f.rules.get("outside_bot")).toBe("deny");
  expect(await f.run("agents", "access", "remove", "weather", "outside_bot")).toMatchObject({
    code: 0, out: { ok: true, handle: "weather", removed: "outside_bot" },
  });
  expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/orgs/org_a/agents/agent-uuid/access/outside_bot" });
  expect(f.rules.size).toBe(0);
});

it("says Relay Server's own sentence and code when the handle cannot go on the list", async () => {
  const f = await fixture();
  expect(await f.run("agents", "access", "allow", "weather", "nobody_here")).toMatchObject({
    code: 3, err: { error: "Contact was not found. Nothing was changed.", code: "2001" },
  });
  expect(await f.run("agents", "access", "deny", "weather", "owner")).toMatchObject({
    code: 1, err: { error: "You can't add that contact to this list. Nothing was changed.", code: "2032" },
  });
  expect(await f.run("agents", "access", "remove", "weather", "alice")).toMatchObject({
    code: 3, err: { error: "Contact was not found. Nothing was changed.", code: "2001" },
  });
});

it("refuses an agent the organization does not have, and changes nothing", async () => {
  const f = await fixture();
  expect(await f.run("agents", "access", "allow", "someone_elses", "alice")).toMatchObject({
    code: 3, err: { error: "Your organization has no agent @someone_elses. Nothing was changed.", code: "not_found" },
  });
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
});

it("needs a Console sign-in", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-access-signed-out-"));
  homes.push(home);
  const fetch = vi.fn();
  const err: string[] = [];
  expect(await runCLI(["--json", "--no-input", "agents", "access", "show", "weather"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home },
    fetch, isInteractive: false, stdout: () => undefined, stderr: (value) => err.push(value),
  })).not.toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.parse(err.join(""))).toMatchObject({ error: "Relay Console is not signed in. Run relay login." });
});
