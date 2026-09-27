import { consoleFixture } from "../test/console-fixture.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { protectWindowsPath } from "./runtime-connect/windows-acl.js";
import { runCLI } from "./program.js";
import { emptyConfig, writeConfig } from "./config.js";
import { DOCS_URL, STAGING_DOCS_URL, docsURL } from "./help-groups.js";

// `relay auth token` is gh's `gh auth token`: the token and a newline on
// stdout, nothing else, so `export RELAY_AGENT_TOKEN=$(relay auth token)` works.
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cli-auth-token-20260927-")));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  homes.push(home);
  const env: NodeJS.ProcessEnv = { RELAY_CONFIG_PATH: join(home, "config.json"), ...extraEnv };
  const out: string[] = [];
  const err: string[] = [];
  const fetch = vi.fn(async () => { throw new Error("auth token must not touch the network"); });
  const deps = {
    configContext: { env, home }, cwd: home, isInteractive: false, fetch,
    stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
  };
  return { deps, env, out, err, fetch, home };
}

async function saved(context: { env: NodeJS.ProcessEnv; home: string }) {
  const config = emptyConfig();
  config.profiles.default = { ...config.profiles.default, agent_token: "rly_default_fixture_token" };
  config.profiles.other = { api_url: "https://api.staging.relayapp.im", agent_token: "rly_other_fixture_token" };
  config.profiles.empty = { api_url: "https://api.staging.relayapp.im" };
  await writeConfig(config, context);
}

describe("relay auth token", () => {
  it("prints exactly the saved token and a newline on stdout, and nothing on stderr", async () => {
    const f = await fixture();
    await saved(f.deps.configContext);
    expect(await runCLI(["--agent", "no", "auth", "token"], f.deps)).toBe(0);
    expect(f.out.join("")).toBe("rly_default_fixture_token\n");
    expect(f.err.join("")).toBe("");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [["--profile", "other", "auth", "token"]],
    [["auth", "token", "--profile", "other"]],
  ])("--profile selects that profile's token (%j)", async (args) => {
    const f = await fixture();
    await saved(f.deps.configContext);
    expect(await runCLI(["--agent", "no", ...args], f.deps)).toBe(0);
    expect(f.out.join("")).toBe("rly_other_fixture_token\n");
    expect(f.err.join("")).toBe("");
  });

  it("follows auth status's order: RELAY_AGENT_TOKEN before the saved profile", async () => {
    const f = await fixture({ RELAY_AGENT_TOKEN: "rly_env_fixture_token" });
    await saved(f.deps.configContext);
    expect(await runCLI(["--agent", "no", "auth", "token"], f.deps)).toBe(0);
    expect(f.out.join("")).toBe("rly_env_fixture_token\n");
    expect(await runCLI(["--agent", "no", "auth", "status"], f.deps)).toBe(0);
    expect(JSON.parse(f.out.slice(1).join("")).token_source).toBe("environment");
  });

  it.each([
    [["auth", "token"], "Profile default has no saved token."],
    [["--profile", "empty", "auth", "token"], "Profile empty has no saved token."],
    [["--json", "auth", "token"], "\"code\": \"no_token\""],
  ])("with no token %j exits 4, prints nothing on stdout, and says so on stderr", async (args, message) => {
    const f = await fixture();
    if (args.includes("empty")) await saved(f.deps.configContext);
    expect(await runCLI(["--agent", "no", ...args], f.deps)).toBe(4);
    expect(f.out.join("")).toBe("");
    expect(f.err.join("")).toContain(message);
  });

  it("is listed once in relay auth --help", async () => {
    const f = await fixture();
    expect(await runCLI(["--agent", "no", "auth", "--help"], f.deps)).toBe(0);
    expect(f.out.join("").split("\n").filter((line) => /^\s+token\b/u.test(line))).toEqual([
      expect.stringMatching(/^\s+token\s+print the token, for a script$/u),
    ]);
  });

  it("agents create names the command that prints the saved token, and that command prints it", async () => {
    const f = await fixture();
    const card = { handle: "brave_cangoo", first_name: "Brave Canada Goose", last_name: null, image_url: null, is_active: true, kind: "agent" };
    const api = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ agent: card, secret: "rly_created_fixture_token", share_url: "https://go.test/@brave_cangoo" }, { status: 201 })
      : Response.json({ contact_cards: [card] }));
    const console = consoleFixture(f.deps.configContext, card);
    const deps = { ...f.deps, consoleLogin: console.login, skillPresent: async () => true, fetch: console.wrap(api) };
    expect(await runCLI(["--agent", "no", "agents", "create", "--subtitle", "Helps with tasks"], deps)).toBe(0);
    const created = f.out.join("");
    expect(created).toContain(`Token saved in ${join(f.home, "config.json")}\nPrint it with \`relay auth token --profile brave_cangoo\`.\n`);
    expect(created + f.err.join("")).not.toContain("rly_created_fixture_token");
    f.out.length = 0; f.err.length = 0;
    expect(await runCLI(["--agent", "no", "auth", "token", "--profile", "brave_cangoo"], deps)).toBe(0);
    expect(f.out.join("")).toBe("rly_created_fixture_token\n");
  });
});

describe("the docs address follows the Relay the CLI talks to", () => {
  it.each([
    ["0.1.14-staging.48", {}, STAGING_DOCS_URL],
    ["0.1.14", {}, DOCS_URL],
    ["0.1.14", { RELAY_API_URL: "https://api.staging.relayapp.im" }, STAGING_DOCS_URL],
    ["0.1.14-staging.48", { RELAY_API_URL: "https://api.relayapp.im" }, DOCS_URL],
    ["0.1.14", { RELAY_API_URL: "http://127.0.0.1:8787" }, DOCS_URL],
    ["0.1.14-staging.48", { RELAY_API_URL: "not a url" }, STAGING_DOCS_URL],
  ] as [string, NodeJS.ProcessEnv, string][])("version %s with %j => %s", (version, env, expected) => {
    expect(docsURL(env, version)).toBe(expected);
  });

  it("pins the two addresses", () => {
    expect([DOCS_URL, STAGING_DOCS_URL]).toEqual(["https://docs.relayapp.im", "https://docs.staging.relayapp.im"]);
  });

  it.each([
    ["https://api.staging.relayapp.im", "Docs: https://docs.staging.relayapp.im"],
    ["https://api.relayapp.im", "Docs: https://docs.relayapp.im"],
  ])("help and usage errors print the docs for RELAY_API_URL=%s", async (apiURL, line) => {
    const f = await fixture({ RELAY_API_URL: apiURL });
    expect(await runCLI(["--agent", "no", "auth", "--help"], f.deps)).toBe(0);
    expect(f.out.join("").trimEnd().split("\n").at(-2)).toBe(line);
    expect(await runCLI(["--agent", "no", "--nope"], f.deps)).toBe(2);
    expect(f.err.join("")).toContain(line);
  });
});
