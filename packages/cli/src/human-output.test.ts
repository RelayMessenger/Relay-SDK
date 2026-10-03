import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emptyConfig, writeConfig } from "./config.js";
import { waitingLine } from "./console-auth.js";
import { runCLI } from "./program.js";

// A person at a terminal reads sentences, the way `gh auth login --web` and
// the vercel CLI answer: the one-time code once, the address once, one line
// that turns while Relay waits, and a check mark. --json, a pipe and a coding
// agent keep reading JSON.

const AUTH = "https://auth.staging.relayapp.im";
const CONSOLE = "https://console.staging.relayapp.im/api";
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const me = () => Response.json({
  user: { id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" },
  org: { id: "org_1", name: "Analytical Engines" },
});

async function fixture(signedIn: boolean) {
  const home = await mkdtemp(join(tmpdir(), "relay-human-output-"));
  homes.push(home);
  const configContext = { env: { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_AUTH_URL: AUTH }, cwd: home };
  const config = emptyConfig();
  if (signedIn) {
    config.console = {
      access_token: "session-secret", expires_at: Date.now() + 3600_000,
      organization_id: "org_1", user: { id: "user_1", email: "ada@gmail.com" },
    };
  }
  await writeConfig(config, configContext);
  const out: string[] = [], err: string[] = [], opened: string[] = [];
  let poll = 0;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${AUTH}/api/auth/device/code`) {
      return Response.json({
        device_code: "device-secret", user_code: "XHB74UTJ",
        verification_uri: `${AUTH}/device`, verification_uri_complete: `${AUTH}/device?user_code=XHB74UTJ`,
        expires_in: 1800, interval: 1,
      });
    }
    if (url === `${AUTH}/api/auth/device/token`) {
      poll += 1;
      return poll === 1
        ? Response.json({ error: "authorization_pending" }, { status: 400 })
        : Response.json({ access_token: "session-secret", token_type: "Bearer", expires_in: 2592000, scope: "" });
    }
    if (url === `${AUTH}/api/auth/get-session`) {
      return Response.json({
        session: { token: "session-secret", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
        user: { id: "user_1", email: "ada@gmail.com", name: "Ada Lovelace" },
      });
    }
    if (url === `${CONSOLE}/me`) return me();
    throw new Error(`unexpected request ${url}`);
  });
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  return {
    out, err, opened,
    dependencies: {
      configContext, fetch, updateCheck: false as const,
      stdout: (value: string) => { out.push(value); },
      stderr: (value: string) => { err.push(value); },
      openBrowser: async (url: string) => { opened.push(url); },
    },
  };
}

it("login at a terminal prints the code and the address once and ends on a check mark, never JSON", async () => {
  const f = await fixture(false);
  expect(await runCLI(["login"], { ...f.dependencies, humanOutput: true })).toBe(0);
  const printed = f.err.join("") + f.out.join("");
  expect(f.out.join("")).toBe("✓ Logged in to Relay as ada@gmail.com (Analytical Engines)\n");
  expect(printed.split("XHB74UTJ").length - 1).toBe(2); // the code line, and the address that carries it
  expect(printed.split(`${AUTH}/device`).length - 1).toBe(1);
  expect(f.err.join("")).toContain("! Your one-time code: XHB74UTJ\n");
  expect(f.err.join("")).toContain("Waiting for you to approve in the browser");
  expect(f.opened).toEqual([`${AUTH}/device?user_code=XHB74UTJ`]);
  for (const hidden of ["{", "organization_id", "org_1", "user_1", "session-secret", "device-secret", "\u001b[2J", "\u001b[H"]) {
    expect(printed).not.toContain(hidden);
  }
});

it("login with --json, or for a caller that reads stdout, stays JSON", async () => {
  const f = await fixture(false);
  expect(await runCLI(["login", "--json"], { ...f.dependencies, humanOutput: true })).toBe(0);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true, organization_id: "org_1", token: "stored" });
  const g = await fixture(false);
  expect(await runCLI(["login"], g.dependencies)).toBe(0);
  expect(JSON.parse(g.out.join(""))).toMatchObject({ ok: true, organization_id: "org_1" });
});

it("a coding agent still reads JSON from login, after the Agent detected line", async () => {
  const f = await fixture(false);
  expect(await runCLI(["login"], {
    ...f.dependencies, humanOutput: true,
    detectAgent: async () => ({ isAgent: true, agent: { name: "codex" } }) as never,
  })).toBe(0);
  expect(f.err.join("")).toContain("Agent detected");
  expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true, organization_id: "org_1", token: "stored" });
});

it("whoami and agents list answer a person in sentences", async () => {
  const f = await fixture(true);
  expect(await runCLI(["whoami"], { ...f.dependencies, humanOutput: true })).toBe(0);
  expect(f.out.join("")).toBe("✓ Logged in to Relay as ada@gmail.com (Analytical Engines)\n");
  f.out.length = 0;
  expect(await runCLI(["agents", "list"], { ...f.dependencies, humanOutput: true })).toBe(0);
  expect(f.out.join("")).toBe("No agents are saved on this computer. Create one with relaymessenger agents create.\n");
  f.out.length = 0;
  expect(await runCLI(["agents", "list"], f.dependencies)).toBe(0);
  expect(JSON.parse(f.out.join(""))).toEqual({ agents: [] });
});

it("the waiting line turns in place and erases itself: no screen clear, no new lines", () => {
  const written: string[] = [];
  const line = waitingLine((value) => written.push(value), "Waiting", 1_000_000);
  line.stop();
  const all = written.join("");
  expect(all).toMatch(/^\r\u001b\[2K⠋ Waiting\r\u001b\[2K$/u);
  expect(all).not.toContain("\n");
});
