import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI, type ProgramDependencies } from "./program.js";
import { readConfig } from "./config.js";
import type { InteractivePrompts } from "./interactive.js";
import { claudeMarketplaceSource, CLAUDE_PLUGIN_ID, runtimeConnectPlan, waitForNewSender } from "./connect.js";
import type { RuntimeFound } from "./runtime-sniff.js";
import type { TerminalObserver } from "./terminal-watch.js";

const token = `rly_live_${"C".repeat(43)}`;
const card = { handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true };

const runtimes = (found = true): RuntimeFound[] => [
  { id: "claude", label: "Claude Code", executable: "/fake/bin/claude", found, supported: true },
  { id: "hermes", label: "Hermes", configPath: "/fake/home/.hermes", found, supported: false },
  { id: "openclaw", label: "OpenClaw", found: false, supported: false },
];

async function fixture(overrides: Partial<ProgramDependencies> = {}) {
  const home = await mkdtemp(join(tmpdir(), "relay-connect-"));
  const env: NodeJS.ProcessEnv = { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: "https://api.staging.relayapp.im", PATH: "" };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts = {
    select: vi.fn(async () => "new"),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => token),
    text: vi.fn(async (_message: string, initial: string) => initial),
    info: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    step: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  } satisfies InteractivePrompts;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input;
    if (init?.method === "POST") {
      return Response.json({ agent: card, secret: token, share_url: `https://staging.relayapp.im/@${card.handle}` }, { status: 201 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ contact_cards: [card] });
  });
  const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const startCommand = vi.fn(async () => 0);
  const observer: TerminalObserver = { semantics: "observational-no-ack", run: async () => undefined };
  const deps: ProgramDependencies = {
    configContext: { env, home, platform: "linux" },
    cwd: home,
    isInteractive: true,
    prompts,
    fetch,
    skillPresent: async () => true,
    skillInstaller: async () => undefined,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    connect: { sniff: async () => runtimes(), runCommand, startCommand, observer: () => observer, renderQR: () => "[QR]\n", pairTimeoutMs: 10, version: "0.1.6-staging.0" },
    ...overrides,
  };
  return { deps, env, home, prompts, fetch, runCommand, startCommand, stdout, stderr, channel: join(home, ".claude", "channels", "relay") };
}

describe("the plan screen", () => {
  it("names every command it will run and every file it will write", () => {
    const plan = runtimeConnectPlan({
      runtime: "claude", env: {}, home: "/home/dev", marketplaceSource: "RelayMessenger/Relay-SDK@staging", start: true,
    });
    expect(plan.headline).toBe("Relay will do 4 things. Continue?");
    expect(plan.steps).toEqual([
      "  1  run  claude plugin marketplace add RelayMessenger/Relay-SDK@staging",
      "  2  run  claude plugin install relay@relay-messenger --yes, then  claude plugin enable relay@relay-messenger",
      "  3  write  /home/dev/.claude/channels/relay/.env  (token, API address, allowed senders)",
      "  4  start Claude Code with Relay when you are ready",
    ]);
  });

  it("says replace, not write, when a token is already there", () => {
    const plan = runtimeConnectPlan({
      runtime: "claude", env: {}, home: "/home/dev", marketplaceSource: "x@main", start: false, replacing: "@other.dev",
    });
    expect(plan.steps.at(-1)).toContain("replace the token already in  /home/dev/.claude/channels/relay/.env");
    expect(plan.headline).toBe("Relay will do 3 things. Continue?");
  });

  it("names each other runtime's own files and its own installer", () => {
    const hermes = runtimeConnectPlan({ runtime: "hermes", env: {}, home: "/home/dev", marketplaceSource: "x@main", start: false });
    expect(hermes.steps.join("\n")).toContain("hermes plugins install RelayMessenger/Relay-Hermes --enable");
    expect(hermes.steps.join("\n")).toContain("/home/dev/.hermes/.env");
    const openclaw = runtimeConnectPlan({ runtime: "openclaw", env: {}, home: "/home/dev", marketplaceSource: "x@main", start: false, handle: "devbot.dev" });
    expect(openclaw.steps.join("\n")).toContain("openclaw plugins install @relaymessenger/openclaw-plugin");
    expect(openclaw.steps.join("\n")).toContain("/home/dev/.openclaw/secrets/relay-devbot.dev.token");
    expect(openclaw.steps.join("\n")).toContain("/home/dev/.openclaw/openclaw.json");
  });

  it("a staging build takes the plugin from staging, a release from main", () => {
    expect(claudeMarketplaceSource("0.1.6-staging.0")).toBe("RelayMessenger/Relay-SDK@staging");
    expect(claudeMarketplaceSource("0.1.6")).toBe("RelayMessenger/Relay-SDK@main");
  });

  it("--dry-run prints the plan, asks nothing, and changes nothing", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "claude", "--dry-run"], f.deps)).toBe(0);
    const printed = f.stdout.join("");
    expect(printed).toContain("Claude Code found  /fake/bin/claude");
    expect(printed).toContain("Relay will do 5 things. Continue?");
    expect(printed).toContain("create a new agent and save its token privately on this computer");
    expect(printed).toContain(`claude plugin marketplace add ${claudeMarketplaceSource("0.1.6-staging.0")}`);
    expect(printed).toContain(join(f.home, ".claude", "channels", "relay", ".env"));
    expect(printed).toContain("Dry run: nothing was changed.");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.prompts.confirm).not.toHaveBeenCalled();
  });
});

describe("the Claude Code path", () => {
  it("creates the agent, runs the three plugin commands, and writes an owner-only .env", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(f.runCommand.mock.calls.map(([, args]) => (args as string[]).join(" "))).toEqual([
      `plugin marketplace add ${claudeMarketplaceSource("0.1.6-staging.0")}`,
      `plugin install ${CLAUDE_PLUGIN_ID} --yes`,
      `plugin enable ${CLAUDE_PLUGIN_ID}`,
    ]);
    const written = await readFile(join(f.channel, ".env"), "utf8");
    expect(written).toContain(`RELAY_AGENT_TOKEN="${token}"`);
    expect(written).toContain('RELAY_BASE_URL="https://api.staging.relayapp.im"');
    expect(written).toContain('RELAY_ALLOWED_SENDERS="advait"');
    expect((await stat(join(f.channel, ".env"))).mode & 0o777).toBe(0o600);
    expect((await readConfig(f.deps.configContext)).profiles[card.handle]?.agent_token).toBe(token);
    expect(f.startCommand).not.toHaveBeenCalled();
    expect([...f.stdout, ...f.stderr].join("")).not.toContain(token);
  });

  it("a token already there for another agent is kept unless the person replaces it", async () => {
    const f = await fixture();
    const kept = `rly_live_${"D".repeat(43)}`;
    await mkdir(f.channel, { recursive: true });
    await writeFile(join(f.channel, ".env"), `RELAY_AGENT_TOKEN="${kept}"\n`, { mode: 0o600 });
    f.prompts.select.mockResolvedValueOnce("keep");
    expect(await runCLI(["connect", "claude", "--new", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(await readFile(join(f.channel, ".env"), "utf8")).toContain(kept);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.stdout.join("")).toContain("Kept the token for");
    // Replace writes the new one and leaves nothing of the old.
    f.prompts.select.mockResolvedValueOnce("replace");
    expect(await runCLI(["connect", "claude", "--new", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    const written = await readFile(join(f.channel, ".env"), "utf8");
    expect(written).toContain(token);
    expect(written).not.toContain(kept);
  });

  it("a failed plugin command says the runtime's own words and writes nothing", async () => {
    const f = await fixture();
    f.runCommand.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "marketplace not found\n" });
    expect(await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(1);
    expect(f.stderr.join("")).toContain("marketplace not found");
    expect(f.stderr.join("")).toContain("Nothing else was changed");
    await expect(readFile(join(f.channel, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Hermes and OpenClaw print their plan and stop without writing", async () => {
    for (const runtime of ["hermes", "openclaw"] as const) {
      const f = await fixture();
      expect(await runCLI(["connect", runtime, "--new", "--yes"], f.deps)).toBe(1);
      expect(f.stdout.join("")).toContain("Relay would do");
      expect(f.stderr.join("")).toContain("is not yet supported in this build. Nothing was changed.");
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.runCommand).not.toHaveBeenCalled();
    }
  });

  it("pairing takes the first sender who is not allowed yet, and ignores the rest", async () => {
    const seen: TerminalObserver = {
      semantics: "observational-no-ack",
      async run(input) {
        input.onEvent({ event_type: "message.sent", data: { sender_handle: { handle: "someone" }, parts: [] } } as never);
        input.onEvent({ event_type: "message.received", data: { sender_handle: { handle: "known" }, parts: [] } } as never);
        input.onEvent({ event_type: "message.received", data: { sender_handle: { handle: "advait" }, parts: [{ type: "text", value: "hi" }] } } as never);
      },
    };
    expect(await waitForNewSender(seen, ["known"], { timeoutMs: 1000 })).toEqual({ handle: "advait", text: "hi" });
    const silent: TerminalObserver = { semantics: "observational-no-ack", run: async () => undefined };
    expect(await waitForNewSender(silent, [], { timeoutMs: 5 })).toBeUndefined();
  });
});

describe("with no terminal", () => {
  const headless = { isInteractive: false } as const;

  it.each([
    [["connect"], "name the runtime after the command"],
    [["connect", "claude"], "--new"],
    [["connect", "claude", "--new"], "--yes"],
    [["connect", "claude", "--new", "--yes"], "--allow <handles>"],
  ])("%j exits 2 and names the flag that would have answered", async (argv, expected) => {
    const f = await fixture(headless);
    expect(await runCLI(argv as string[], f.deps)).toBe(2);
    const said = f.stderr.join("");
    expect(said).toContain("There is no terminal here, so nothing was asked.");
    expect(said).toContain(expected);
    expect(said).not.toContain("Usage:");
  });

  it("--json turns every error into an error and a next step", async () => {
    const f = await fixture(headless);
    expect(await runCLI(["connect", "claude", "--json"], f.deps)).toBe(2);
    const answer = JSON.parse(f.stderr.join(""));
    expect(Object.keys(answer).sort()).toEqual(["error", "next_step"]);
    expect(answer.error).toContain("Relay cannot ask which agent to connect");
    expect(answer.next_step).toContain("--token <token>");

    const plain = await fixture(headless);
    expect(await runCLI(["--json", "connect", "nonsense"], plain.deps)).toBe(1);
    const refusal = JSON.parse(plain.stderr.join(""));
    expect(refusal.error).toContain("Name one of: claude, hermes, openclaw.");
    expect(refusal.next_step).toBe("npx relaymessenger connect");
  });

  it("--dry-run needs no terminal at all", async () => {
    const f = await fixture(headless);
    expect(await runCLI(["connect", "claude", "--dry-run"], f.deps)).toBe(0);
    expect(f.stdout.join("")).toContain("Dry run: nothing was changed.");
  });
});
