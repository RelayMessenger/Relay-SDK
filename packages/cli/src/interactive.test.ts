import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "./program.js";
import { emptyConfig, readConfig, writeConfig } from "./config.js";
import { InteractiveCancelled, interactiveAllowed, type InteractivePrompts } from "./interactive.js";
import { installerEnvironment, RELAY_SKILL_INSTALL_ARGS, relaySkillPresent } from "./skill-offer.js";

const token = `rly_live_${"I".repeat(43)}`;
const card = { handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-interactive-"));
  const env: NodeJS.ProcessEnv = { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: "https://api.staging.relayapp.im" };
  const stdout: string[] = []; const stderr: string[] = [];
  const prompts = {
    select: vi.fn(async () => "exit"), confirm: vi.fn(async () => false),
    password: vi.fn(async () => token), text: vi.fn(async (_message: string, initial: string) => initial),
    info: vi.fn((message: string) => { stderr.push(message); }),
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
  it("offers the six root choices and exit does nothing", async () => {
    const f = await fixture();
    expect(await runCLI([], f.deps)).toBe(0);
    const options = (f.prompts.select.mock.calls[0] as unknown as [string, Array<{ label: string }>])[1];
    expect(options.map((option) => option.label)).toEqual(["Create agent", "Sign in with an existing token", "List saved agents", "Delete agent", "Install Relay skill", "Exit"]);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.skillPresent).not.toHaveBeenCalled(); expect(f.skillInstaller).not.toHaveBeenCalled();
  });
  it("delegates creation once and declining its one skill offer leaves success intact", async () => {
    const f = await fixture(); f.prompts.select.mockResolvedValueOnce("create");
    f.prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await runCLI([], f.deps)).toBe(0);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect((await readConfig(f.deps.configContext)).profiles[card.handle]?.agent_token).toBe(token);
    expect(f.skillPresent).toHaveBeenCalledOnce(); expect(f.skillInstaller).not.toHaveBeenCalled(); expect(f.prompts.confirm).toHaveBeenCalledTimes(2);
    expect(f.stdout.join("")).not.toContain(token);
  });
  it("cancellation or a declined create confirmation performs no mutation", async () => {
    const f = await fixture(); f.prompts.select.mockRejectedValueOnce(new InteractiveCancelled());
    expect(await runCLI([], f.deps)).toBe(0);
    f.prompts.select.mockResolvedValueOnce("create");
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
  it("interactive delete declines safely; non-interactive delete needs no --yes", async () => {
    const f = await fixture(); const config = emptyConfig(); config.profiles.saved = { api_url: "https://api.staging.relayapp.im", agent_token: token };
    await writeConfig(config, f.deps.configContext);
    expect(await runCLI(["--profile", "saved", "agents", "delete", card.handle], f.deps)).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled(); expect((await readConfig(f.deps.configContext)).profiles.saved?.agent_token).toBe(token);
    f.prompts.confirm.mockClear();
    expect(await runCLI(["--non-interactive", "--profile", "saved", "agents", "delete", card.handle], f.deps)).toBe(0);
    expect(f.prompts.confirm).not.toHaveBeenCalled(); expect((await readConfig(f.deps.configContext)).profiles.saved?.agent_token).toBeUndefined();
  });
  it("installer failure after creation does not fail or repeat the successful POST", async () => {
    const f = await fixture(); f.prompts.confirm.mockResolvedValueOnce(true); f.skillInstaller.mockRejectedValueOnce(new Error(token));
    expect(await runCLI(["agents", "create"], f.deps)).toBe(0);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(f.skillInstaller).toHaveBeenCalledOnce(); expect(f.stderr.join("")).toContain("unchanged");
    expect(f.stderr.join("")).not.toContain(token);
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
  it("CI or piped use never constructs menus/offers", async () => {
    const f = await fixture(); f.env.CI = "true";
    expect(await runCLI([], f.deps)).toBe(0);
    delete f.env.CI;
    expect(await runCLI(["agents", "list"], { ...f.deps, isInteractive: false })).toBe(0);
    expect(f.prompts.select).not.toHaveBeenCalled(); expect(f.skillPresent).not.toHaveBeenCalled();
  });
  it("explicit install menu asks permission once and invokes only injected standard installer", async () => {
    const f = await fixture(); f.prompts.select.mockResolvedValueOnce("skill"); f.prompts.confirm.mockResolvedValueOnce(true);
    expect(await runCLI([], f.deps)).toBe(0);
    expect(f.skillInstaller).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
  });
});

it("detects only existing source-backed project/global Relay skill files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "relay-skill-project-")); const home = await mkdtemp(join(tmpdir(), "relay-skill-home-"));
  expect(await relaySkillPresent(cwd, home, {})).toBe(false);
  await mkdir(join(home, ".codex", "skills", "relay"), { recursive: true });
  await writeFile(join(home, ".codex", "skills", "relay", "SKILL.md"), "fixture");
  expect(await relaySkillPresent(cwd, home, {})).toBe(true);
});
it("uses fixed installer args without default agent/global flags or credentials", () => {
  expect(RELAY_SKILL_INSTALL_ARGS).toEqual(["--yes", "skills@1.5.24", "add", "https://github.com/RelayMessenger/Relay-SDK/tree/staging/skills/relay", "--skill", "relay"]);
  const parent = { PATH: "keep", HOME: "/private-home", RELAY_AGENT_TOKEN: token, OPENAI_API_KEY: "other-secret", PSModulePath: "not-needed" };
  expect(installerEnvironment(parent)).toEqual({ PATH: "keep", HOME: "/private-home" });
  expect(parent.RELAY_AGENT_TOKEN).toBe(token);
  expect(interactiveAllowed([], { GITHUB_ACTIONS: "true" }, true)).toBe(false);
});

it("interactive creation collects optional fields; blanks keep server defaults", { timeout: 120_000 }, async () => {
  const f = await fixture(); f.prompts.select.mockResolvedValueOnce("create");
  f.prompts.text.mockResolvedValueOnce("custom_agent.dev").mockResolvedValueOnce("Custom Agent").mockResolvedValueOnce("https://images.example.test/photo.png").mockResolvedValueOnce("");
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
it("explicit install-only failure exits nonzero, without API calls or credential output", async () => {
  const f = await fixture(); f.prompts.select.mockResolvedValueOnce("skill"); f.prompts.confirm.mockResolvedValueOnce(true);
  f.skillInstaller.mockRejectedValueOnce(new Error(token));
  expect(await runCLI([], f.deps)).toBe(1);
  expect(f.skillInstaller).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
  expect(f.stderr.join("")).not.toContain(token);
});
it("cancelled optional post-create offer preserves the completed creation", async () => {
  const f = await fixture(); f.prompts.confirm.mockRejectedValueOnce(new InteractiveCancelled());
  expect(await runCLI(["agents", "create"], f.deps)).toBe(0);
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(f.skillInstaller).not.toHaveBeenCalled();
});
