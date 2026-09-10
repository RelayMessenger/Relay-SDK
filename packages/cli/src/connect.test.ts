import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI, type ProgramDependencies } from "./program.js";
import { readConfig } from "./config.js";
import type { InteractivePrompts } from "./interactive.js";
import { claudeMarketplaceSource, CLAUDE_PLUGIN_ID, NO_TTY_NEXT_STEP, NO_TTY_SENTENCE, waitForNewSender } from "./connect.js";
import { CODING_AGENT_IDS, codingAgent } from "./coding-agents.js";
import type { RuntimeFound } from "./runtime-sniff.js";
import type { TerminalObserver } from "./terminal-watch.js";
import { expectOwnerOnly } from "./private-file.test.js";

const token = `rly_live_${"C".repeat(43)}`;
const card = { handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true };

const runtimes = (found: Partial<Record<RuntimeFound["id"], Partial<RuntimeFound>>> = {}): RuntimeFound[] =>
  CODING_AGENT_IDS.map((id) => ({ id, label: id, found: false, ...found[id] }));
const claudeAndHermes = runtimes({
  "claude-code": { label: "Claude Code", executable: "/fake/bin/claude", found: true },
  hermes: { label: "Hermes", configPath: "/fake/home/.hermes", found: true },
});

async function fixture(overrides: Partial<ProgramDependencies> = {}, sniffed: RuntimeFound[] = claudeAndHermes) {
  const home = await mkdtemp(join(tmpdir(), "relay-connect-"));
  const env: NodeJS.ProcessEnv = { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: "https://api.staging.relayapp.im", PATH: "" };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts = {
    select: vi.fn(async () => "new"),
    multiselect: vi.fn(async (_message: string, _options: unknown, initial: string[]) => initial),
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
    configContext: { env, home, platform: process.platform },
    cwd: home,
    isInteractive: true,
    prompts,
    fetch,
    skillPresent: async () => true,
    skillInstaller: async () => undefined,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    connect: { sniff: async () => sniffed, runCommand, startCommand, observer: () => observer, renderQR: () => "[QR]\n", pairTimeoutMs: 10, version: "0.1.6-staging.0" },
    ...overrides,
  };
  return { deps, env, home, prompts, fetch, runCommand, startCommand, stdout, stderr, channel: join(home, ".claude", "channels", "relay") };
}

const ranLines = (f: Awaited<ReturnType<typeof fixture>>): string[] =>
  f.runCommand.mock.calls.map(([file, args]) => [file, ...(args as string[])].join(" "));

describe("the plan screen", () => {
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

  it.each([...CODING_AGENT_IDS, "claude"])("--dry-run --json --non-interactive %s answers ok with the file it would write", async (id) => {
    const f = await fixture({ isInteractive: false });
    expect(await runCLI(["connect", "--dry-run", "--json", "--non-interactive", id], f.deps)).toBe(0);
    const answer = JSON.parse(f.stdout.join(""));
    expect(answer.ok).toBe(true);
    expect(answer.dry_run).toBe(true);
    expect(answer.agents).toHaveLength(1);
    expect(answer.agents[0].agent).toBe(id === "claude" ? "claude-code" : id);
    expect(answer.agents[0].files.length).toBeGreaterThan(0);
    for (const file of answer.agents[0].files) expect(file.startsWith(f.home) || file.startsWith("/Applications")).toBe(true);
    expect(answer.steps.join("\n")).toContain(answer.agents[0].files[0]);
    expect(f.stderr.join("")).toBe("");
  });
});

describe("choosing agents", () => {
  it("asks with every agent listed and the detected ones pre-selected, and detection never chooses", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "--dry-run"], f.deps)).toBe(0);
    expect(f.prompts.multiselect).toHaveBeenCalledOnce();
    const [message, options, initial] = f.prompts.multiselect.mock.calls[0]!;
    expect(message).toContain("Which coding agents should Relay connect?");
    expect(message).toContain("Detected agents are pre-selected");
    expect((options as Array<{ value: string }>).map((option) => option.value)).toEqual(CODING_AGENT_IDS);
    expect(initial).toEqual(["claude-code", "hermes"]);
    expect(f.stdout.join("")).toContain("Claude Code found");
    expect(f.stdout.join("")).toContain("Hermes found");
  });

  it("--all takes every detected agent and none other", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "--all", "--dry-run", "--json"], f.deps)).toBe(0);
    expect(f.prompts.multiselect).not.toHaveBeenCalled();
    expect(JSON.parse(f.stdout.join("")).agents.map((entry: { agent: string }) => entry.agent)).toEqual(["claude-code", "hermes"]);
    const none = await fixture({}, runtimes());
    expect(await runCLI(["connect", "--all", "--dry-run", "--json"], none.deps)).toBe(1);
    expect(JSON.parse(none.stderr.join("")).error).toContain("No coding agent was found on this computer");
  });

  it("an unknown name is refused with the supported list", async () => {
    const f = await fixture({ isInteractive: false });
    expect(await runCLI(["--json", "connect", "nonsense"], f.deps)).toBe(1);
    const refusal = JSON.parse(f.stderr.join(""));
    expect(refusal.error).toBe(`Unknown agent: nonsense. Supported agents: ${CODING_AGENT_IDS.join(" ")}`);
    expect(refusal.next_step).toBe("npx relaymessenger connect --help");
  });

  it("inside a coding agent, that agent is pre-selected and the ● line says so once", async () => {
    const f = await fixture({ isInteractive: false, connect: undefined });
    f.deps.connect = { sniff: async () => claudeAndHermes, version: "0.1.6-staging.0", drivingAgent: "codex" };
    expect(await runCLI(["connect", "--dry-run"], f.deps)).toBe(0);
    expect(f.stderr.join("")).toBe("●  codex  Agent detected — connecting non-interactively\n");
    expect(f.stdout.join("")).toContain("codex mcp add relay");
    // Under --json the stderr stream stays JSON-only.
    const quiet = await fixture({ isInteractive: false });
    quiet.deps.connect = { ...quiet.deps.connect, drivingAgent: "codex" };
    expect(await runCLI(["connect", "--dry-run", "--json"], quiet.deps)).toBe(0);
    expect(quiet.stderr.join("")).toBe("");
  });
});

describe("the Claude Code path", () => {
  it("creates the agent, runs the three plugin commands, and writes an owner-only .env", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(ranLines(f)).toEqual([
      `/fake/bin/claude plugin marketplace add ${claudeMarketplaceSource("0.1.6-staging.0")}`,
      `/fake/bin/claude plugin install ${CLAUDE_PLUGIN_ID} --yes`,
      `/fake/bin/claude plugin enable ${CLAUDE_PLUGIN_ID}`,
    ]);
    const written = await readFile(join(f.channel, ".env"), "utf8");
    expect(written).toContain(`RELAY_AGENT_TOKEN="${token}"`);
    expect(written).toContain('RELAY_BASE_URL="https://api.staging.relayapp.im"');
    expect(written).toContain('RELAY_ALLOWED_SENDERS="advait"');
    await expectOwnerOnly(join(f.channel, ".env"), f.channel);
    expect((await readConfig(f.deps.configContext)).profiles[card.handle]?.agent_token).toBe(token);
    expect(f.startCommand).not.toHaveBeenCalled();
    expect([...f.stdout, ...f.stderr].join("")).not.toContain(token);
    expect(f.stdout.join("")).toContain("Relay is ready for Claude Code.");
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

  it("a failed plugin command says the agent's own words and writes nothing", async () => {
    const f = await fixture();
    f.runCommand.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "marketplace not found\n" });
    expect(await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(1);
    expect(f.stderr.join("")).toContain("marketplace not found");
    expect(f.stderr.join("")).toContain("Nothing else was changed");
    await expect(readFile(join(f.channel, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
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

describe("the MCP agents", () => {
  const server = (f: Awaited<ReturnType<typeof fixture>>): Record<string, unknown> => ({
    command: "npx", args: ["-y", "@relaymessenger/mcp@staging", "--profile", card.handle], env: { RELAY_CONFIG_PATH: f.env.RELAY_CONFIG_PATH },
  });

  it("codex, gemini-cli and cline run their own mcp add and write nothing themselves", async () => {
    const f = await fixture({}, runtimes({ codex: { found: true, executable: "/fake/bin/codex" } }));
    expect(await runCLI(["connect", "codex", "--new", "--yes", "--no-skill", "--json"], f.deps)).toBe(0);
    expect(ranLines(f)).toEqual([`/fake/bin/codex mcp add relay --env RELAY_CONFIG_PATH=${f.env.RELAY_CONFIG_PATH} -- npx -y @relaymessenger/mcp@staging --profile ${card.handle}`]);
    const answer = JSON.parse(f.stdout.join(""));
    expect(answer).toMatchObject({ ok: true, handle: card.handle, token: "stored" });
    expect(answer.agents[0]).toMatchObject({ agent: "codex", files: [join(f.home, ".codex", "config.toml")] });
    expect(f.stdout.join("")).not.toContain(token);

    const g = await fixture({}, runtimes());
    expect(await runCLI(["connect", "gemini", "--token", token, "--yes", "--no-skill"], g.deps)).toBe(0);
    expect(ranLines(g)).toEqual([`gemini mcp add -s user -e=RELAY_CONFIG_PATH=${g.env.RELAY_CONFIG_PATH} relay npx -- -y @relaymessenger/mcp@staging --profile ${card.handle}`]);
    expect(g.stdout.join("")).toContain("Gemini CLI was not found on this computer; you named it, so Relay will try anyway");

    const c = await fixture({}, runtimes());
    expect(await runCLI(["connect", "cline", "--token", token, "--yes", "--no-skill"], c.deps)).toBe(0);
    expect(ranLines(c)).toEqual([`cline mcp add --yes relay -- npx -y @relaymessenger/mcp@staging --profile ${card.handle}`]);
  });

  it("cursor and claude-desktop add mcpServers.relay and keep every other entry", async () => {
    const f = await fixture({}, runtimes());
    const cursor = join(f.home, ".cursor", "mcp.json");
    await mkdir(join(f.home, ".cursor"), { recursive: true });
    await writeFile(cursor, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
    expect(JSON.parse(await readFile(cursor, "utf8"))).toEqual({ mcpServers: { other: { command: "x" }, relay: server(f) }, theme: "dark" });
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.stdout.join("")).toContain("You might have to restart 'Cursor'.");

    const d = await fixture({}, runtimes());
    expect(await runCLI(["connect", "claude-desktop", "--token", token, "--yes", "--no-skill"], d.deps)).toBe(0);
    const method = codingAgent("claude-desktop").connect;
    if (method.kind !== "mcp-file") throw new Error("Expected a file connector");
    const file = method.file({ home: d.home, env: d.env, platform: process.platform });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcpServers: { relay: server(d) } });
  });

  it("vscode writes servers.relay with type stdio; opencode writes mcp.relay in its own shape", async () => {
    const f = await fixture({}, runtimes());
    expect(await runCLI(["connect", "vscode", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
    const method = codingAgent("vscode").connect;
    if (method.kind !== "mcp-file") throw new Error("Expected a file connector");
    const file = method.file({ home: f.home, env: f.env, platform: process.platform });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ servers: { relay: { type: "stdio", ...server(f) } } });

    const o = await fixture({}, runtimes());
    expect(await runCLI(["connect", "opencode", "--token", token, "--yes", "--no-skill"], o.deps)).toBe(0);
    expect(JSON.parse(await readFile(join(o.home, ".config", "opencode", "opencode.json"), "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { relay: { type: "local", command: ["npx", "-y", "@relaymessenger/mcp@staging", "--profile", card.handle], environment: { RELAY_CONFIG_PATH: o.env.RELAY_CONFIG_PATH }, enabled: true } },
    });
  });

  it("a config file that is not JSON is left alone and named", async () => {
    const f = await fixture({}, runtimes());
    const cursor = join(f.home, ".cursor", "mcp.json");
    await mkdir(join(f.home, ".cursor"), { recursive: true });
    await writeFile(cursor, "{ not json");
    expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(1);
    expect(f.stderr.join("")).toContain(`${cursor} is not plain JSON, so Relay did not change it.`);
    expect(await readFile(cursor, "utf8")).toBe("{ not json");
  });

  it("several agents at once share one agent, one plan and one confirmation", async () => {
    const f = await fixture({}, runtimes({ codex: { found: true, executable: "/fake/bin/codex" }, cursor: { found: true, configPath: "/fake/.cursor" } }));
    expect(await runCLI(["connect", "--all", "--new", "--no-skill"], f.deps)).toBe(0);
    expect(f.prompts.confirm).toHaveBeenCalledTimes(1);
    expect(f.stdout.join("")).toContain("Relay will do 2 things. Continue?");
    expect(ranLines(f)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(f.home, ".cursor", "mcp.json"), "utf8")).mcpServers.relay).toEqual(server(f));
    expect(f.stdout.join("")).toContain("Relay is ready for Codex, Cursor.");
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

describe("Hermes and OpenClaw", () => {
  it("Hermes installs our plugin and writes the four settings the docs name, owner-only", async () => {
    const f = await fixture({}, runtimes({ hermes: { found: true, executable: "/fake/bin/hermes" } }));
    expect(await runCLI(["connect", "hermes", "--token", token, "--yes", "--allow", "00000000-0000-7000-8000-000000000901", "--no-skill"], f.deps)).toBe(0);
    expect(ranLines(f)).toEqual(["/fake/bin/hermes plugins install RelayMessenger/Relay-Hermes --enable"]);
    const envPath = join(f.home, ".hermes", ".env");
    const written = await readFile(envPath, "utf8");
    expect(written).toContain(`RELAY_AGENT_TOKEN="${token}"`);
    expect(written).toContain('RELAY_BASE_URL="https://api.staging.relayapp.im"');
    expect(written).toContain(`RELAY_STATE_DIR="${process.platform === "win32" ? join(f.home, ".hermes", "relay").replace(/\\/gu, "/") : join(f.home, ".hermes", "relay")}"`);
    expect(written).toContain('RELAY_ALLOWED_CONTACTS="00000000-0000-7000-8000-000000000901"');
    await expectOwnerOnly(envPath, join(f.home, ".hermes"));
    expect(f.stdout.join("")).toContain("hermes gateway run");
    expect([...f.stdout, ...f.stderr].join("")).not.toContain(token);
  });

  it("Hermes keeps a token already there unless told to replace it", async () => {
    const f = await fixture({ isInteractive: false }, runtimes());
    await mkdir(join(f.home, ".hermes"), { recursive: true });
    await writeFile(join(f.home, ".hermes", ".env"), `RELAY_AGENT_TOKEN="rly_live_${"E".repeat(43)}"\nOTHER=1\n`, { mode: 0o600 });
    expect(await runCLI(["connect", "hermes", "--token", token, "--no-skill"], f.deps)).toBe(2);
    expect(f.stderr.join("")).toContain("--yes  to replace it");
    expect(await readFile(join(f.home, ".hermes", ".env"), "utf8")).toContain("E".repeat(43));
    expect(await runCLI(["connect", "hermes", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
    const written = await readFile(join(f.home, ".hermes", ".env"), "utf8");
    expect(written).toContain(token);
    expect(written).not.toContain("E".repeat(43));
    expect(written).toContain("OTHER=1");
  });

  it("OpenClaw installs our plugin, keeps the token in its own owner-only file, and adds channels.relay", async () => {
    const f = await fixture({}, runtimes({ openclaw: { found: true, executable: "/fake/bin/openclaw" } }));
    const config = join(f.home, ".openclaw", "openclaw.json");
    await mkdir(join(f.home, ".openclaw"), { recursive: true });
    await writeFile(config, JSON.stringify({ gateway: { port: 1 }, channels: { telegram: { enabled: true } } }));
    expect(await runCLI(["connect", "openclaw", "--token", token, "--yes", "--allow", "alice", "--no-skill"], f.deps)).toBe(0);
    expect(ranLines(f)).toEqual(["/fake/bin/openclaw plugins install @relaymessenger/openclaw-plugin@staging --force --accept-capabilities"]);
    const tokenFile = join(f.home, ".openclaw", "secrets", `relay-${card.handle}.token`);
    expect(await readFile(tokenFile, "utf8")).toBe(`${token}\n`);
    await expectOwnerOnly(tokenFile, join(f.home, ".openclaw", "secrets"));
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      gateway: { port: 1 },
      channels: { telegram: { enabled: true }, relay: { enabled: true, baseUrl: "https://api.staging.relayapp.im", tokenFile, allowFrom: ["alice"] } },
    });
    expect(await readFile(config, "utf8")).not.toContain(token);
  });
});

describe("with no terminal", () => {
  const headless = { isInteractive: false } as const;

  it("nothing named exits 2 with the no-TTY sentence and its next step, in words and in JSON", async () => {
    const f = await fixture(headless);
    expect(await runCLI(["connect"], f.deps)).toBe(2);
    expect(f.stderr.join("")).toBe(`Error: ${NO_TTY_SENTENCE} ${NO_TTY_NEXT_STEP}\n`);
    expect(f.prompts.multiselect).not.toHaveBeenCalled();
    const j = await fixture(headless);
    expect(await runCLI(["connect", "--json"], j.deps)).toBe(2);
    expect(JSON.parse(j.stderr.join(""))).toEqual({ error: NO_TTY_SENTENCE, next_step: NO_TTY_NEXT_STEP });
  });

  it.each([
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
  });

  it("-y is --yes", async () => {
    const f = await fixture(headless, runtimes());
    expect(await runCLI(["connect", "cursor", "--token", token, "-y", "--no-skill"], f.deps)).toBe(0);
    expect(JSON.parse(await readFile(join(f.home, ".cursor", "mcp.json"), "utf8")).mcpServers.relay.command).toBe("npx");
  });
});
