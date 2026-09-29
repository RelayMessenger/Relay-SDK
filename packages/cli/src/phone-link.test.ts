import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultAuthURL, defaultConsoleApiURL, emptyConfig, readConfig, writeConfig, type RelayConsoleSession } from "./config.js";
import type { InteractivePrompts } from "./interactive.js";
import { runCLI } from "./program.js";

/**
 * A stub of Relay-Auth's phone-link contract (branch phone-link-20260926):
 *   POST /api/auth/phone-link/send-otp {phoneNumber}
 *   POST /api/auth/phone-link/verify   {phoneNumber, code}
 *     → {status: "attached" | "merged", user: {id, phoneNumber, phoneNumberVerified}}
 * refusing a wrong code the way Better Auth's phoneNumber plugin names it.
 * Relay-Auth commit a5c8462 moves the session with a merge, so the same
 * bearer names the merged user; the stub also covers a `set-auth-token`
 * header, the bearer plugin's way of handing out a new session.
 */
const auth = defaultAuthURL();
const consoleApi = defaultConsoleApiURL();
const bearer = "session-before-link-0123456789";
const survivor = "session-after-merge-9876543210";
const number = "+15551234567";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(options: { outcome?: "attached" | "merged"; session?: RelayConsoleSession | null; deployed?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "relay-phone-"));
  homes.push(home);
  const context = { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, cwd: home };
  const config = emptyConfig();
  if (options.session !== null) {
    config.console = options.session ?? {
      access_token: bearer, expires_at: Date.now() + 60_000, organization_id: "org_console",
      user: { id: "console-user", email: "dev@example.com" },
    };
  }
  await writeConfig(config, context);
  const calls: Array<{ url: string; body?: Record<string, string>; auth: string | null }> = [];
  let sentCode: string | undefined;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : undefined;
    calls.push({ url, ...(body ? { body } : {}), auth: new Headers(init?.headers).get("authorization") });
    if (options.deployed === false) return new Response("Not Found", { status: 404 });
    if (url === `${auth}/api/auth/phone-link/send-otp`) {
      if (!/^\+[1-9]\d{7,14}$/u.test(body?.phoneNumber ?? "")) return Response.json({ code: "INVALID_PHONE_NUMBER", message: "Invalid phone number" }, { status: 400 });
      sentCode = "123456";
      return Response.json({ status: true });
    }
    if (url === `${auth}/api/auth/phone-link/verify`) {
      if (body?.code !== "123456") return Response.json({ code: "INVALID_OTP", message: "Invalid OTP" }, { status: 400 });
      const merged = options.outcome === "merged";
      return Response.json(
        { status: merged ? "merged" : "attached", user: { id: merged ? "phone-user" : "console-user", phoneNumber: body.phoneNumber, phoneNumberVerified: true } },
        { headers: merged ? { "set-auth-token": survivor } : {} },
      );
    }
    if (url === `${auth}/api/auth/get-session`) {
      return Response.json({ user: { id: "phone-user", email: "dev@example.com", name: "Dev" }, session: { expiresAt: "2026-12-01T00:00:00.000Z" } });
    }
    if (url === `${consoleApi}/me`) return Response.json({ org: { id: "org_console" } });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const out: string[] = [], err: string[] = [];
  const cli = { configContext: context, fetch, stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value) };
  return { context, calls, fetch, out, err, cli, sent: () => sentCode };
}

const scripted = (answers: string[]): InteractivePrompts & { asked: string[]; said: string[] } => {
  const asked: string[] = [], said: string[] = [];
  return {
    asked, said,
    text: vi.fn(async (message: string, _initial: string, options?: { validate?: (value: string) => string | undefined }) => {
      asked.push(message);
      const answer = answers.shift() ?? "";
      expect(options?.validate?.(answer)).toBeUndefined();
      return answer;
    }),
    select: vi.fn(), confirm: vi.fn(), password: vi.fn(), info: vi.fn(),
    intro: vi.fn(), outro: vi.fn(), spinner: vi.fn(),
    step: vi.fn((line: string) => { said.push(line); }),
    message: vi.fn((line: string) => { said.push(line); }),
  } as unknown as InteractivePrompts & { asked: string[]; said: string[] };
};

it("at a terminal: asks the number, texts a code, asks the code, and links it with the Console session", async () => {
  const f = await fixture();
  const prompts = scripted([number, "123456"]);
  expect(await runCLI(["phone", "link"], { ...f.cli, isInteractive: true, prompts })).toBe(0);
  expect(prompts.asked).toEqual(["Your phone number, with its country code", "The six-digit code in the text message"]);
  expect(prompts.said).toEqual([`Relay texted a code to ${number}.`]);
  expect(f.calls.map((call) => [call.url, call.body])).toEqual([
    [`${auth}/api/auth/phone-link/send-otp`, { phoneNumber: number }],
    [`${auth}/api/auth/phone-link/verify`, { phoneNumber: number, code: "123456" }],
  ]);
  expect(f.calls.every((call) => call.auth === `Bearer ${bearer}`)).toBe(true);
  expect(JSON.parse(f.out.join(""))).toEqual({
    ok: true, status: "attached", phone_number: number, user: { id: "console-user" }, session: "unchanged",
  });
  expect(f.err.join("")).toContain("is linked. Sign in to the Relay app with it");
  expect(f.out.join("") + f.err.join("")).not.toContain(bearer);
  expect((await readConfig(f.context)).console).toMatchObject({ access_token: bearer });
});

it("at a terminal: asks again after a mistyped code", async () => {
  const f = await fixture();
  const prompts = scripted([number, "654321", "123456"]);
  expect(await runCLI(["phone", "link"], { ...f.cli, isInteractive: true, prompts })).toBe(0);
  expect(prompts.said).toContain("That code is not right. Check it and try again.");
  expect(f.calls.filter((call) => call.url.endsWith("/verify")).map((call) => call.body?.code)).toEqual(["654321", "123456"]);
});

it("without a terminal: --number texts the code and stops; --number with --code links", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "phone", "link", "--number", number], { ...f.cli, isInteractive: false })).toBe(0);
  expect(JSON.parse(f.out.join(""))).toEqual({ ok: true, status: "code_sent", phone_number: number });
  expect(f.calls.map((call) => call.url)).toEqual([`${auth}/api/auth/phone-link/send-otp`]);
  f.out.length = 0;
  expect(await runCLI(["--json", "phone", "link", "--number", number, "--code", "123456"], { ...f.cli, isInteractive: false })).toBe(0);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true, status: "attached" });
  // The second step does not text a second code.
  expect(f.calls.map((call) => call.url)).toEqual([`${auth}/api/auth/phone-link/send-otp`, `${auth}/api/auth/phone-link/verify`]);
});

it("without a terminal and without --number: names the flags and sends nothing", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "phone", "link"], { ...f.cli, isInteractive: false })).toBe(2);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(JSON.parse(f.err.join(""))).toMatchObject({ code: "not_a_tty" });
  expect(f.err.join("")).toContain("--number <+15551234567> --code <123456>");
});

it("on merged: saves the surviving session the way relay login saves it", async () => {
  const f = await fixture({ outcome: "merged" });
  expect(await runCLI(["--json", "phone", "link", "--number", number, "--code", "123456"], { ...f.cli, isInteractive: false })).toBe(0);
  expect(JSON.parse(f.out.join(""))).toEqual({
    ok: true, status: "merged", phone_number: number, user: { id: "phone-user" }, session: "refreshed",
  });
  const refresh = f.calls.slice(1);
  expect(refresh.map((call) => [call.url, call.auth])).toEqual([
    [`${auth}/api/auth/get-session`, `Bearer ${survivor}`],
    [`${consoleApi}/me`, `Bearer ${survivor}`],
  ]);
  expect((await readConfig(f.context)).console).toEqual({
    access_token: survivor,
    expires_at: Date.parse("2026-12-01T00:00:00.000Z"),
    organization_id: "org_console",
    user: { id: "phone-user", email: "dev@example.com", name: "Dev" },
  });
  expect(f.out.join("") + f.err.join("")).not.toContain(survivor);
});

it.each([
  [["--number", "5551234567"], "Enter your phone number with its country code, for example +15551234567."],
  [["--number", number, "--code", "12ab"], "The code is the six digits in the text message."],
])("refuses %j before any request", async (flags, sentence) => {
  const f = await fixture();
  expect(await runCLI(["--json", "phone", "link", ...flags], { ...f.cli, isInteractive: false })).toBe(2);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(JSON.parse(f.err.join(""))).toMatchObject({ error: sentence, code: "usage" });
});

it("says a wrong code in one sentence without a terminal, and keeps the saved session", async () => {
  const f = await fixture();
  expect(await runCLI(["--json", "phone", "link", "--number", number, "--code", "000000"], { ...f.cli, isInteractive: false })).toBe(1);
  expect(JSON.parse(f.err.join(""))).toMatchObject({ error: "That code is not right. Check it and try again.", code: "refused" });
  expect((await readConfig(f.context)).console).toMatchObject({ access_token: bearer });
});

it("on merged without a new token: the same bearer now names the merged user, and is saved again", async () => {
  const f = await fixture({ outcome: "merged" });
  f.fetch.mockImplementationOnce(async () => Response.json({ status: "merged", user: { id: "phone-user", phoneNumber: number, phoneNumberVerified: true } }));
  expect(await runCLI(["--json", "phone", "link", "--number", number, "--code", "123456"], { ...f.cli, isInteractive: false })).toBe(0);
  // The mocked verify is not recorded; the refresh that follows is.
  expect(f.calls.map((call) => [call.url, call.auth])).toEqual([
    [`${auth}/api/auth/get-session`, `Bearer ${bearer}`],
    [`${consoleApi}/me`, `Bearer ${bearer}`],
  ]);
  expect((await readConfig(f.context)).console).toMatchObject({ access_token: bearer, user: { id: "phone-user" } });
});

it("says Relay-Auth's own sentence when the number belongs to another console account", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => Response.json({ code: "PHONE_NUMBER_IN_USE", message: "This phone number belongs to another console account." }, { status: 409 }));
  expect(await runCLI(["--json", "phone", "link", "--number", number, "--code", "123456"], { ...f.cli, isInteractive: false })).toBe(1);
  expect(JSON.parse(f.err.join(""))).toMatchObject({ error: "This phone number belongs to another console account. Nothing was changed." });
});

it("says so plainly when Relay-Auth does not offer phone linking yet", async () => {
  const f = await fixture({ deployed: false });
  expect(await runCLI(["--json", "phone", "link", "--number", number], { ...f.cli, isInteractive: false })).toBe(1);
  expect(JSON.parse(f.err.join(""))).toMatchObject({ error: "This Relay does not offer phone linking yet. Nothing was changed." });
});

it.each([
  ["signed out", null, "Relay Console is not signed in. Run relay login first."],
  ["an organization key", { type: "organization_key", organization_key: "rel_org_fixtureKey", organization_id: "org_k", console_api_url: consoleApi } as RelayConsoleSession, "An organization API key has no phone. Run relay login to sign in as yourself."],
])("needs a person's sign-in (%s)", async (_label, session, sentence) => {
  const f = await fixture({ session });
  expect(await runCLI(["--json", "phone", "link", "--number", number], { ...f.cli, isInteractive: false })).not.toBe(0);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(JSON.parse(f.err.join(""))).toMatchObject({ error: sentence });
});
