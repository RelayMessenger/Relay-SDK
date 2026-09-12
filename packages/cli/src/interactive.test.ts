import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "./program.js";
import { STAGING_API_URL, defaultCreationApiURL, emptyConfig, packageVersion, readConfig, writeConfig } from "./config.js";
import { InteractiveCancelled, interactiveAllowed, type InteractivePrompts } from "./interactive.js";
import { installerEnvironment, RELAY_SKILL_INSTALL_ARGS, relaySkillInstallArgs, relaySkillPresent, relaySkillSourceBranch } from "./skill-offer.js";

const token = `rly_live_${"I".repeat(43)}`;
const card = { handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-interactive-"));
  const env: NodeJS.ProcessEnv = { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: "https://api.staging.relayapp.im" };
  const stdout: string[] = []; const stderr: string[] = [];
  const prompts = {
    select: vi.fn(async () => "exit"), multiselect: vi.fn(async (_m: string, _o: unknown, initial: string[]) => initial), confirm: vi.fn(async () => false),
    password: vi.fn(async () => token), text: vi.fn(async (_message: string, initial: string) => initial),
    info: vi.fn((message: string) => { stderr.push(message); }),
    intro: vi.fn(), outro: vi.fn(), step: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    success: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    message: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    note: vi.fn((message: string, title: string) => { stdout.push(`${title}\n${message}\n`); }),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  } satisfies InteractivePrompts;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe("https://api.staging.relayapp.im");
    if (init?.method === "POST") {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return Response.json({ agent: card, secret: token, share_url: `https://go.staging.relayapp.im/@${card.handle}` }, { status: 201 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ contact_cards: [card] });
  });
  const skillInstaller = vi.fn(async () => undefined);
  const skillPresent = vi.fn(async (): Promise<boolean | "unknown"> => false);
  const deps = { configContext: { env, home }, cwd: home, isInteractive: true, prompts, fetch, skillInstaller, skillPresent,
    stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) };
  return { deps, env, home, prompts, fetch, skillInstaller, skillPresent, stdout, stderr };
}

describe("interactive Commander adapter", { timeout: 120_000 }, () => {
  it("offers the three root choices and exit does nothing", async () => {
    const f = await fixture();
    expect(await runCLI([], f.deps)).toBe(0);
    const options = (f.prompts.select.mock.calls[0] as unknown as [string, Array<{ label: string }>])[1];
    expect(options.map((option) => option.label)).toEqual(["Connect an agent", "Watch an agent", "Exit"]);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.skillPresent).not.toHaveBeenCalled(); expect(f.skillInstaller).not.toHaveBeenCalled();
  });
  it("cancelled root selection or optional field input performs no mutation", async () => {
    const f = await fixture(); f.prompts.select.mockRejectedValueOnce(new InteractiveCancelled());
    expect(await runCLI([], f.deps)).toBe(0);
    f.prompts.select.mockResolvedValueOnce("create");
    f.prompts.text.mockRejectedValueOnce(new InteractiveCancelled());
    expect(await runCLI(["agents"], f.deps)).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.skillInstaller).not.toHaveBeenCalled();
    await expect(readFile(f.env.RELAY_CONFIG_PATH!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("auth entry delegates to password + existing Agent API without creation", async () => {
    const f = await fixture(); f.prompts.select.mockResolvedValueOnce("login");
    expect(await runCLI(["auth"], f.deps)).toBe(0);
    expect(f.prompts.password).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect((await readConfig(f.deps.configContext)).profiles.default?.agent_token).toBe(token);
    expect([...f.stdout, ...f.stderr].join("")).not.toContain(token);
  });
  it("password cancellation does not persist or call the API", async () => {
    const f = await fixture(); f.prompts.select.mockResolvedValueOnce("login"); f.prompts.password.mockRejectedValueOnce(new InteractiveCancelled());
    expect(await runCLI(["auth"], f.deps)).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.skillPresent).not.toHaveBeenCalled();
  });

  // Owner ruling, 2026-09-09: the Relay skill is offered at the end of a
  // successful connect, and nowhere else. Setup must never open with it.
  it.each([
    [["agents", "create"]],
    [["agents"]],
    [["auth", "login"]],
    [["auth"]],
  ])("%j never asks about the Relay skill", async (argv) => {
    const f = await fixture();
    if (argv[0] === "agents" && argv.length === 1) f.prompts.select.mockResolvedValueOnce("create");
    if (argv[0] === "auth" && argv.length === 1) f.prompts.select.mockResolvedValueOnce("login");
    expect(await runCLI(argv as string[], f.deps)).toBe(0);
    expect(f.skillPresent).not.toHaveBeenCalled();
    expect(f.skillInstaller).not.toHaveBeenCalled();
    for (const [message] of f.prompts.confirm.mock.calls as unknown as Array<[string]>) {
      expect(message.toLowerCase()).not.toContain("skill");
    }
  });

  it("a full connect offers the skill exactly once, at the end", async () => {
    const f = await fixture();
    const code = await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start"], {
      ...f.deps,
      connect: {
        sniff: async () => [{ id: "claude", label: "Claude Code", executable: "/fake/claude", found: true, supported: true }],
        runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
        version: "0.1.6-staging.0",
      },
    });
    expect(f.stderr.join(""), "connect should not fail").toBe("");
    expect(code).toBe(0);
    expect(f.skillPresent).toHaveBeenCalledOnce();
  });
  it("interactive delete declines safely; non-interactive delete needs no --yes", async () => {
    const f = await fixture(); const config = emptyConfig(); config.profiles.saved = { api_url: "https://api.staging.relayapp.im", agent_token: token };
    await writeConfig(config, f.deps.configContext);
    expect(await runCLI(["--profile", "saved", "agents", "delete", card.handle], f.deps)).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled(); expect((await readConfig(f.deps.configContext)).profiles.saved?.agent_token).toBe(token);
    f.prompts.confirm.mockClear();
    expect(await runCLI(["--non-interactive", "--profile", "saved", "agents", "delete", card.handle], f.deps)).toBe(0);
    expect(f.prompts.confirm).not.toHaveBeenCalled(); expect((await readConfig(f.deps.configContext)).profiles.saved?.agent_token).toBeUndefined();
  });
  it("an installed skill or unknown detection never triggers an optional install", async () => {
    for (const state of [true, "unknown"] as const) {
      const f = await fixture(); f.skillPresent.mockResolvedValueOnce(state);
      expect(await runCLI(["agents", "list"], f.deps)).toBe(0);
      expect(f.prompts.confirm).not.toHaveBeenCalled(); expect(f.skillInstaller).not.toHaveBeenCalled();
    }
  });
  it.each([["--help"], ["--version"], ["--json", "agents", "list"], ["agents", "list", "--json"], ["--non-interactive", "agents", "list"]])("never offers optional prompts for %j", async (...args) => {
    const f = await fixture();
    expect(await runCLI(args as string[], f.deps)).toBe(0);
    expect(f.prompts.select).not.toHaveBeenCalled(); expect(f.prompts.confirm).not.toHaveBeenCalled(); expect(f.skillPresent).not.toHaveBeenCalled();
  });
  it("piped use never constructs menus/offers", async () => {
    const f = await fixture();
    expect(await runCLI(["agents", "list"], { ...f.deps, isInteractive: false })).toBe(0);
    expect(f.prompts.select).not.toHaveBeenCalled(); expect(f.skillPresent).not.toHaveBeenCalled();
  });
  it("a CI variable suppresses the menu per decision rows 8 and 17", async () => {
    // The terminal decides, never an ambient variable: every one of the 27 tools
    // measured on 2026-09-09 ignored CI.
    const f = await fixture(); f.env.CI = "true"; f.env.GITHUB_ACTIONS = "true";
    expect(await runCLI([], f.deps)).toBe(0);
    expect(f.prompts.select).not.toHaveBeenCalled();
  });
});

it("detects only existing source-backed project/global Relay skill files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "relay-skill-project-")); const home = await mkdtemp(join(tmpdir(), "relay-skill-home-"));
  expect(await relaySkillPresent(cwd, home, {})).toBe(false);
  await mkdir(join(home, ".codex", "skills", "relay"), { recursive: true });
  await writeFile(join(home, ".codex", "skills", "relay", "SKILL.md"), "fixture");
  expect(await relaySkillPresent(cwd, home, {})).toBe(true);
});
it("installer args follow the build's environment without default agent/global flags or credentials", () => {
  expect(relaySkillInstallArgs("0.1.0-staging.2")).toEqual(["--yes", "skills@1.5.25", "add", "https://github.com/RelayMessenger/Relay-SDK/tree/staging/skills/relay", "--skill", "relay"]);
  expect(relaySkillInstallArgs("0.1.0")).toEqual(["--yes", "skills@1.5.25", "add", "https://github.com/RelayMessenger/Relay-SDK/tree/main/skills/relay", "--skill", "relay"]);
  expect(relaySkillSourceBranch("0.1.0-staging")).toBe("staging"); expect(relaySkillSourceBranch("0.1.0-rc.1")).toBe("main");
  expect(RELAY_SKILL_INSTALL_ARGS).toEqual(relaySkillInstallArgs(packageVersion()));
  expect(relaySkillSourceBranch(packageVersion())).toBe(defaultCreationApiURL() === STAGING_API_URL ? "staging" : "main");
  const parent = { PATH: "keep", HOME: "/private-home", RELAY_AGENT_TOKEN: token, OPENAI_API_KEY: "other-secret", PSModulePath: "not-needed" };
  expect(installerEnvironment(parent)).toEqual({ PATH: "keep", HOME: "/private-home" });
  expect(parent.RELAY_AGENT_TOKEN).toBe(token);
  expect(interactiveAllowed([], true)).toBe(true);
  expect(interactiveAllowed(["--json"], true)).toBe(false);
  expect(interactiveAllowed([], false)).toBe(false);
});

it("interactive creation collects optional fields; blanks keep server defaults", { timeout: 120_000 }, async () => {
  const f = await fixture(); f.prompts.select.mockResolvedValueOnce("create");
  f.prompts.text.mockResolvedValueOnce("custom_agent.dev").mockResolvedValueOnce("Custom Agent").mockResolvedValueOnce("https://images.example.test/photo.png");
  f.prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await runCLI([], f.deps)).toBe(0);
  const post = f.fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(post[1]?.body))).toEqual({ handle: "custom_agent.dev", first_name: "Custom Agent", image_url: "https://images.example.test/photo.png" });
  const blank = await fixture(); blank.prompts.select.mockResolvedValueOnce("create"); blank.prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await runCLI([], blank.deps)).toBe(0);
  expect(JSON.parse(String(blank.fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body))).toEqual({});
});

it.each(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "HERMES_HOME"])("preserves and detects the installer's selected %s", async (key) => {
  const cwd = await mkdtemp(join(tmpdir(), "relay-selected-cwd-")); const home = await mkdtemp(join(tmpdir(), "relay-selected-home-"));
  const selected = join(home, `selected-${key}`);
  await mkdir(join(selected, "skills", "relay"), { recursive: true });
  await writeFile(join(selected, "skills", "relay", "SKILL.md"), "fixture");
  const env = { [key]: selected, RELAY_AGENT_TOKEN: token, OPENAI_API_KEY: "filtered-key" };
  expect(await relaySkillPresent(cwd, home, env)).toBe(true);
  expect(installerEnvironment(env)).toEqual({ [key]: selected });
});
it("does not let an old default-home installation hide absence in the selected home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "relay-selected-cwd-")); const home = await mkdtemp(join(tmpdir(), "relay-selected-home-"));
  await mkdir(join(home, ".codex", "skills", "relay"), { recursive: true });
  await writeFile(join(home, ".codex", "skills", "relay", "SKILL.md"), "old fixture");
  expect(await relaySkillPresent(cwd, home, { CODEX_HOME: join(home, "selected-empty") })).toBe(false);
  expect(await relaySkillPresent(cwd, home, { CODEX_HOME: "   " })).toBe(true);
});
it("preserves explicit telemetry opt-outs while keeping credentials out of installer env", () => {
  const parent = { PATH: "keep", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", RELAY_AGENT_TOKEN: token, ANTHROPIC_API_KEY: "filtered-key" };
  expect(installerEnvironment(parent)).toEqual({ PATH: "keep", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" });
  expect(parent.RELAY_AGENT_TOKEN).toBe(token);
});

it("Create selection needs no extra confirmation and has exactly three concise optional prompts", async () => {
  const f = await fixture(); f.skillPresent.mockResolvedValue(true); f.prompts.select.mockResolvedValueOnce("create");
  expect(await runCLI([], f.deps)).toBe(0);
  expect(f.prompts.text.mock.calls.map(([message]) => message)).toEqual(["Handle (optional)", "Name (optional)", "Image (optional)"]);
  expect(f.prompts.confirm).not.toHaveBeenCalled();
  expect(f.prompts.info).toHaveBeenCalledTimes(1);
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
