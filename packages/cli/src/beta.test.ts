import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConsoleApiURL, emptyConfig, writeConfig } from "./config.js";
import { runCLI } from "./program.js";

/**
 * A stand-in for Relay Console's beta route (Relay-Console
 * apps/api/src/routes/me.ts): POST /me/beta invites the account email, or
 * apple_id_email; a second address after the first is 409 beta_email_taken.
 */
const api = defaultConsoleApiURL();
const bearer = "console-session-bearer-0123456789";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(options: { signedIn?: boolean; stored?: string | null; appleRefuses?: boolean; accountEmail?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "relay-beta-"));
  homes.push(home);
  const context = { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home };
  const config = emptyConfig();
  if (options.signedIn !== false) {
    config.console = {
      access_token: bearer, expires_at: Date.now() + 60_000, organization_id: "org_a",
      user: { id: "user_1", email: "you@example.com" },
    };
  }
  await writeConfig(config, context);
  let stored = options.stored ?? null;
  const calls: Array<{ method: string; path: string; body?: unknown; auth: string | null }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.slice(new URL(api).pathname.length);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, ...(body ? { body } : {}), auth: new Headers(init?.headers).get("authorization") });
    if (path === "/me/beta" && method === "GET") return Response.json({ account_email: "you@example.com", invited_email: stored });
    if (path === "/me/beta" && method === "POST" && options.appleRefuses) {
      return Response.json({ error: "Beta invites are not sent from this environment.", code: "staging_outbound_disabled" }, { status: 502 });
    }
    if (path === "/me/beta" && method === "POST") {
      const email = body && "apple_id_email" in body ? String(body.apple_id_email) : options.accountEmail ?? "you@example.com";
      if (!email.includes("@") || email.endsWith(".invalid")) return Response.json({ error: "Enter a valid email.", code: "invalid_email" }, { status: 400 });
      if (stored === email) return Response.json({ result: "already", apple_id_email: email });
      if (stored) return Response.json({ error: `The beta was already sent to ${stored}.`, code: "beta_email_taken", apple_id_email: stored }, { status: 409 });
      stored = email;
      return Response.json({ result: "invited", apple_id_email: email });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const out: string[] = [], err: string[] = [];
  const run = async (human: boolean, ...args: string[]) => {
    out.length = 0; err.length = 0;
    const code = await runCLI([...(human ? [] : ["--json"]), "--no-input", ...args], {
      configContext: context, fetch, isInteractive: false, humanOutput: human, updateCheck: false,
      stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value),
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  return { run, calls };
}

it("invites the account email with the Console session, and says so in a sentence", async () => {
  const f = await fixture();
  const result = await f.run(true, "beta");
  expect(result).toMatchObject({ code: 0, out: "Invited you@example.com to the Relay beta. Open the TestFlight email on your iPhone.\n" });
  expect(f.calls).toEqual([{ method: "POST", path: "/me/beta", body: {}, auth: `Bearer ${bearer}` }]);
});

it("says an address already in the beta is already in it, and --json carries the route's body", async () => {
  const f = await fixture({ stored: "you@example.com" });
  expect(await f.run(true, "beta")).toMatchObject({ code: 0, out: "you@example.com is already in the Relay beta.\n" });
  const json = await f.run(false, "beta");
  expect(json.code).toBe(0);
  expect(JSON.parse(json.out)).toEqual({ result: "already", apple_id_email: "you@example.com" });
});

it("sends --email as apple_id_email", async () => {
  const f = await fixture();
  expect((await f.run(true, "beta", "--email", "apple@example.com")).out)
    .toBe("Invited apple@example.com to the Relay beta. Open the TestFlight email on your iPhone.\n");
  expect(f.calls.at(-1)?.body).toEqual({ apple_id_email: "apple@example.com" });
});

it("names the stored address when the beta already went to another one (409)", async () => {
  const f = await fixture({ stored: "first@example.com" });
  const result = await f.run(true, "beta", "--email", "second@example.com");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("The beta was already sent to first@example.com.");
});

it("asks for relay login and sends nothing when no one is signed in", async () => {
  const f = await fixture({ signedIn: false });
  const result = await f.run(true, "beta");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Run relay login.");
  expect(f.calls).toEqual([]);
});

it("says plainly when Apple's invite is not sent (502)", async () => {
  const f = await fixture({ appleRefuses: true });
  const result = await f.run(true, "beta");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Beta invites are not sent from this environment.");
});

it("asks a phone-only account for its Apple ID instead of blaming input it never gave", async () => {
  const f = await fixture({ accountEmail: "phone-15555550100@phone.relay.invalid" });
  const bare = await f.run(true, "beta");
  expect(bare.code).toBe(2);
  expect(bare.err).toContain("Your account has no email Apple can use. Run relay beta --email <your Apple ID email>.");
  const typo = await f.run(true, "beta", "--email", "not-an-email");
  expect(typo.code).toBe(2);
  expect(typo.err).toContain("Enter a valid email.");
});
