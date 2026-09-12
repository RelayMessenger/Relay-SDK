import { NEXT_STEP } from "./error-codes.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI, type ProgramDependencies } from "./program.js";
import { readConfig } from "./config.js";
import type { InteractivePrompts, SelectOption } from "./interactive.js";
import { claudeMarketplaceSource, CLAUDE_PLUGIN_ID, linkedLine, NO_TTY_NEXT_STEP, NO_TTY_SENTENCE, SAY_HI, waitForNewSender } from "./connect.js";
import { folderLinkPath } from "./folder-link.js";
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
    // Enter on every question: the runtime picker takes its default, and
    // "Which agent?" takes "New agent".
    select: vi.fn(async (message: string, options: SelectOption[], initial?: string) => message === "Where does your agent run?" ? initial ?? options[0]!.value : "new"),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => token),
    text: vi.fn(async (_message: string, initial: string) => initial),
    info: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    step: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    message: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn((message: string) => { stdout.push(`${message}\n`); }) })),
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
  // Codex's offer leaves connect answering messages; a test says what it printed
  // and returns, the way Control-C ends it for a person.
  const bridge = vi.fn(async (input: { say(line: string): void }) => { input.say("Codex answered nothing here."); });
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
    connect: { sniff: async () => sniffed, runCommand, startCommand, bridge, observer: () => observer, renderQR: () => "[QR]\n", pairTimeoutMs: 10, version: "0.1.6-staging.0" },
    ...overrides,
  };
  return { deps, env, home, prompts, fetch, runCommand, startCommand, bridge, stdout, stderr, channel: join(home, ".claude", "channels", "relay") };
}

const ranLines = (f: Awaited<ReturnType<typeof fixture>>): string[] =>
  f.runCommand.mock.calls.map(([file, args]) => [file, ...(args as string[])].join(" "));

describe("nothing is created before the plan is taken", () => {
  it("a bad --handle is refused before any question, with the same words", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "--handle", "ci_connectwalk3_1789195591"], f.deps)).toBe(1);
    expect(f.stderr.join("")).toContain("Error: A handle looks like name.dev. The part before .dev must be 3 to 32 characters, start with a lowercase letter, and use only lowercase letters, numbers and underscores.");
    expect(f.prompts.select).not.toHaveBeenCalled();
    expect(f.prompts.confirm).not.toHaveBeenCalled();
    expect(f.prompts.intro).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.stdout.join("")).not.toContain("Creating your agent");
  });

  it("No at Continue creates nothing: no agent, no token, no link", async () => {
    const f = await fixture();
    f.prompts.confirm.mockResolvedValueOnce(false);
    expect(await runCLI(["connect", "claude", "--new", "--handle", "calm_cangoo.dev", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(f.prompts.confirm).toHaveBeenCalledWith("Continue?", { initialValue: true });
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect((await readConfig(f.deps.configContext)).profiles[card.handle]).toBeUndefined();
    await expect(readFile(folderLinkPath(f.home))).rejects.toMatchObject({ code: "ENOENT" });
    // The plan named the creation as its first line, and the creation never started.
    const printed = f.stdout.join("");
    expect(printed).toContain("create a new agent  (@calm_cangoo.dev)");
    expect(printed).not.toContain("Creating your agent");
    expect(printed).not.toContain("Created @");
  });

  it("Yes at Continue creates exactly one agent, after the plan", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "claude", "--new", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(f.prompts.confirm).toHaveBeenCalledWith("Continue?", { initialValue: true });
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const lines = f.stdout.join("").split("\n");
    const plan = lines.findIndex((line) => line.includes("create a new agent  (Relay picks the name)"));
    const created = lines.findIndex((line) => line.startsWith(`Created @${card.handle}`));
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(plan);
    expect((await readConfig(f.deps.configContext)).profiles[card.handle]?.agent_token).toBe(token);
  });
});

describe("the plan screen", () => {
  it("--dry-run prints the three plan lines, asks nothing, and changes nothing", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "claude", "--dry-run"], f.deps)).toBe(0);
    const printed = f.stdout.join("");
    expect(printed).not.toContain("found on this computer");
    expect(printed).toContain(`install  the Relay plugin for Claude Code  (claude plugin marketplace add ${claudeMarketplaceSource("0.1.6-staging.0")}; claude plugin install ${CLAUDE_PLUGIN_ID} --yes)`);
    expect(printed).toContain(`write  ${join(f.home, ".claude", "channels", "relay", ".env")}  (token, API address, allowed senders)`);
    expect(printed).toContain("start Claude Code with Relay when you are ready");
    expect(printed).toContain("Dry run: nothing was changed.");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.prompts.confirm).not.toHaveBeenCalled();
    expect(f.prompts.select).not.toHaveBeenCalled();
    await expect(readFile(folderLinkPath(f.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([...CODING_AGENT_IDS, "claude"])("--dry-run --json --non-interactive %s answers ok with the file it would write", async (id) => {
    const f = await fixture({ isInteractive: false });
    expect(await runCLI(["connect", "--dry-run", "--json", "--non-interactive", id], f.deps)).toBe(0);
    const answer = JSON.parse(f.stdout.join(""));
    expect(answer.ok).toBe(true);
    expect(answer.dry_run).toBe(true);
    expect(answer.agents).toHaveLength(1);
    expect(answer.agents[0].agent).toBe(id === "claude" ? "claude-code" : id);
    const kind = codingAgent(id === "claude" ? "claude-code" : id).connect.kind;
    if (kind === "acp-bridge" || kind === "openclaw-plugin") {
      // The ACP bridge writes no file: the Relay MCP server travels through the
      // agent's session instead (acp-bridge.ts). OpenClaw's own `channels add`
      // keeps the token, so Relay writes no OpenClaw file either.
      expect(answer.agents[0].files).toEqual([]);
      expect(answer.steps.join("\n")).toContain(codingAgent(id === "claude" ? "claude-code" : id).label);
    } else {
      expect(answer.agents[0].files.length).toBeGreaterThan(0);
      for (const file of answer.agents[0].files) expect(file.startsWith(f.home) || file.startsWith("/Applications")).toBe(true);
      expect(answer.steps.length).toBeLessThanOrEqual(3);
    }
    expect(f.stderr.join("")).toBe("");
  });
});

describe("choosing agents", () => {
  it("asks one single-select question: the agents found first, the first of them the default, the rest dimmed", async () => {
    const f = await fixture();
    expect(await runCLI(["connect", "--dry-run", "--yes"], f.deps)).toBe(0);
    expect(f.prompts.select).toHaveBeenCalledOnce();
    const [message, options, initial] = f.prompts.select.mock.calls[0]!;
    expect(message).toBe("Where does your agent run?");
    expect(options.map((option) => option.value)).toEqual(["claude-code", "hermes", ...CODING_AGENT_IDS.filter((id) => id !== "claude-code" && id !== "hermes")]);
    expect(options.slice(0, 2).map((option) => option.dim)).toEqual([undefined, undefined]);
    expect(options.slice(2).every((option) => option.dim === true && option.hint === "not found")).toBe(true);
    expect(initial).toBe("claude-code");
    expect(f.stdout.join("")).not.toContain("found on this computer");
    // Enter took Claude Code, so its plan is the one printed.
    expect(f.stdout.join("")).toContain("install  the Relay plugin for Claude Code");
    // With nothing found the list is the same nine, all dimmed, and no sentence is added.
    const none = await fixture({}, runtimes());
    expect(await runCLI(["connect", "--dry-run", "--yes"], none.deps)).toBe(0);
    const [, bare] = none.prompts.select.mock.calls[0]!;
    expect(bare.map((option) => option.value)).toEqual(CODING_AGENT_IDS);
    expect(bare.every((option) => option.dim === true)).toBe(true);
    expect(none.prompts.info).not.toHaveBeenCalled();
  });

  it("an unknown name is refused with the supported list", async () => {
    const f = await fixture({ isInteractive: false });
    expect(await runCLI(["--json", "connect", "nonsense"], f.deps)).toBe(2);
    const refusal = JSON.parse(f.stderr.join(""));
    expect(refusal.error).toContain(`Unknown agent: nonsense. Runs in: ${CODING_AGENT_IDS.join(" ")}`);
    expect(refusal.code).toBe("usage");
    expect(refusal.next_step).toBe(NEXT_STEP.usage);
  });

  it("inside a runtime, that agent is pre-selected and the ● line says so once", async () => {
    const f = await fixture({ isInteractive: false, connect: undefined });
    f.deps.detectAgent = async () => ({ isAgent: true, agent: { name: "codex" } });
    f.deps.connect = { sniff: async () => claudeAndHermes, version: "0.1.6-staging.0", drivingAgent: "codex" };
    expect(await runCLI(["connect", "--dry-run"], f.deps)).toBe(0);
    expect(f.stderr.join("")).toBe("●  codex  Agent detected — running non-interactively\nDocs: https://docs.relayapp.im/llms.txt\n");
    expect(f.stdout.join("")).toContain("write  ./.codex/config.toml  (Relay's MCP server for this folder; Codex loads it when the folder is trusted)");
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
    // Success is one line per file written, then the phone step with the link and the QR.
    const printed = f.stdout.join("");
    expect(printed).toContain(`wrote  ${join(f.channel, ".env")}`);
    expect(printed).toContain(SAY_HI);
    expect(printed).toContain(`[QR]\nhttps://staging.relayapp.im/@${card.handle}`);
    expect(printed).not.toMatch(/Relay is ready|Open Relay, scan|Later:|opens next/u);
    // No handle question: a new agent gets a picked handle.
    expect(f.prompts.text).not.toHaveBeenCalled();
  });

  it("links the folder to the agent, ignores .relay in git, and a re-run uses the link without asking", async () => {
    const f = await fixture();
    await writeFile(join(f.home, ".gitignore"), "node_modules\n");
    expect(await runCLI(["connect", "claude", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    // No saved agents yet, so "Which agent?" was not asked; the only question was answered by the argument.
    expect(f.prompts.select).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(folderLinkPath(f.home), "utf8"))).toEqual({ handle: card.handle, apiUrl: "https://api.staging.relayapp.im" });
    expect(await readFile(join(f.home, ".gitignore"), "utf8")).toBe("node_modules\n.relay\n");
    expect((await readConfig(f.deps.configContext)).defaultAgent).toBe(card.handle);
    const creates = f.fetch.mock.calls.filter(([, init]) => init?.method === "POST").length;
    expect(creates).toBe(1);

    // Linked: the same agent, said in one line, no question and no new agent.
    f.stdout.length = 0;
    expect(await runCLI(["connect", "claude", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(f.prompts.select).not.toHaveBeenCalled();
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(creates);
    expect(f.stdout.join("")).toContain(linkedLine(card.handle));

    // --new makes a fresh agent for this folder and re-links it.
    expect(await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(creates + 1);
  });

  it("asks Which agent? only when saved agents exist, New agent first and the default", async () => {
    const f = await fixture();
    // A saved agent on this computer, and no link in this folder.
    expect(await runCLI(["connect", "claude", "--new", "--yes", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    const { rm } = await import("node:fs/promises");
    await rm(join(f.home, ".relay"), { recursive: true });
    f.prompts.select.mockClear();
    // "New agent" again: the .env still holds the first agent's token, and a new
    // agent always gets its own, so the replace question is asked and answered.
    f.prompts.select.mockImplementation(async (message: string, options: SelectOption[], initial?: string) =>
      message === "Where does your agent run?" ? initial ?? options[0]!.value : message.startsWith("Claude Code already has") ? "replace" : "new");
    expect(await runCLI(["connect", "claude", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    const asked = f.prompts.select.mock.calls.find(([message]) => message === "Which agent?");
    expect(asked).toBeDefined();
    const [, options, initial] = asked!;
    expect(options.map((option) => option.label)).toEqual(["New agent", `@${card.handle}`]);
    expect(initial).toBe("new");
    // Picking the saved one creates nothing and links the folder to it.
    await rm(join(f.home, ".relay"), { recursive: true });
    const posts = f.fetch.mock.calls.filter(([, init]) => init?.method === "POST").length;
    f.prompts.select.mockImplementationOnce(async (message: string, options: SelectOption[], initial?: string) => message === "Which agent?" ? card.handle : initial ?? options[0]!.value);
    expect(await runCLI(["connect", "claude", "--allow", "advait", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(posts);
    expect(JSON.parse(await readFile(folderLinkPath(f.home), "utf8")).handle).toBe(card.handle);
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

  it("codex gets [mcp_servers.relay] written into this folder's .codex/config.toml, and runs no command", async () => {
    const f = await fixture({}, runtimes({ codex: { found: true, executable: "/fake/bin/codex" } }));
    const file = join(f.home, ".codex", "config.toml");
    await mkdir(join(f.home, ".codex"), { recursive: true });
    await writeFile(file, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(await runCLI(["connect", "codex", "--new", "--yes", "--no-skill", "--json"], f.deps)).toBe(0);
    expect(ranLines(f)).toEqual([]);
    const answer = JSON.parse(f.stdout.join(""));
    expect(answer).toMatchObject({ ok: true, handle: card.handle, token: "stored", link: { path: folderLinkPath(f.home), handle: card.handle, api_url: "https://api.staging.relayapp.im" } });
    expect(answer.agents[0]).toMatchObject({ agent: "codex", files: [file], commands: [] });
    const { parse } = await import("smol-toml");
    expect(parse(await readFile(file, "utf8"))).toEqual({
      model: "o3",
      mcp_servers: { other: { command: "x" }, relay: { ...server(f) } },
    });
    expect(f.stdout.join("")).not.toContain(token);
  });

  it("the ACP agents write no mcp.json and run no command; Relay drives them over ACP", async () => {
    // Cursor: no mcp.json is written even when one is already there, and no
    // command is run. The Relay MCP server travels through the session instead.
    const f = await fixture({}, runtimes());
    const cursor = join(f.home, ".cursor", "mcp.json");
    await mkdir(join(f.home, ".cursor"), { recursive: true });
    await writeFile(cursor, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(await readFile(cursor, "utf8"))).toEqual({ mcpServers: { other: { command: "x" } }, theme: "dark" });
    expect(f.runCommand).not.toHaveBeenCalled();
    const cursorAnswer = JSON.parse(f.stdout.join(""));
    expect(cursorAnswer.agents[0]).toMatchObject({ agent: "cursor", files: [], bridge_command: "cursor-agent", bridge_args: ["acp"] });

    // Gemini CLI, OpenCode and Cline are the same: no file, and their own ACP words.
    for (const [id, command, args] of [["gemini", "gemini", ["--experimental-acp"]], ["opencode", "opencode", ["acp"]], ["cline", "cline", ["--acp"]]] as const) {
      const g = await fixture({}, runtimes());
      expect(await runCLI(["connect", id, "--token", token, "--yes", "--no-skill", "--json"], g.deps)).toBe(0);
      expect(g.runCommand).not.toHaveBeenCalled();
      expect(JSON.parse(g.stdout.join("")).agents[0]).toMatchObject({ files: [], bridge_command: command, bridge_args: args });
    }
  });

  it("vscode writes servers.relay with type stdio, and keeps every other entry", async () => {
    const f = await fixture({}, runtimes());
    const method = codingAgent("vscode").connect;
    if (method.kind !== "mcp-file") throw new Error("Expected a file connector");
    const file = method.file({ home: f.home, env: f.env, platform: process.platform });
    await mkdir(join(f.home, ".config", "Code", "User"), { recursive: true }).catch(() => undefined);
    expect(await runCLI(["connect", "vscode", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ servers: { relay: { type: "stdio", ...server(f) } } });
  });

  it("a config file that is not JSON is left alone and named", async () => {
    const f = await fixture({}, runtimes());
    const method = codingAgent("vscode").connect;
    if (method.kind !== "mcp-file") throw new Error("Expected a file connector");
    const file = method.file({ home: f.home, env: f.env, platform: process.platform });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    expect(await runCLI(["connect", "vscode", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(1);
    expect(f.stderr.join("")).toContain(`${file} is not plain JSON, so Relay did not change it.`);
    expect(await readFile(file, "utf8")).toBe("{ not json");
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

  it("OpenClaw installs our plugin, then adds the channel through its own command; Relay writes no OpenClaw file", async () => {
    const f = await fixture({}, runtimes({ openclaw: { found: true, executable: "/fake/bin/openclaw" } }));
    const config = join(f.home, ".openclaw", "openclaw.json");
    await mkdir(join(f.home, ".openclaw"), { recursive: true });
    const before = JSON.stringify({ gateway: { port: 1 }, channels: { telegram: { enabled: true } } });
    await writeFile(config, before);
    expect(await runCLI(["connect", "openclaw", "--token", token, "--yes", "--allow", "alice", "--no-skill", "--json"], f.deps)).toBe(0);
    expect(ranLines(f)).toEqual([
      "/fake/bin/openclaw plugins install @relaymessenger/openclaw-plugin@staging --force --accept-capabilities",
      `/fake/bin/openclaw channels add relay --token ${token} --base-url https://api.staging.relayapp.im`,
    ]);
    expect(await readFile(config, "utf8")).toBe(before);
    await expect(readFile(join(f.home, ".openclaw", "secrets", `relay-${card.handle}.token`))).rejects.toMatchObject({ code: "ENOENT" });
    const answer = JSON.parse(f.stdout.join(""));
    expect(answer.agents[0]).toMatchObject({ agent: "openclaw", files: [], channel: "relay", start_command: "/fake/bin/openclaw gateway" });
    // The token is a flag on OpenClaw's command, and never on any screen.
    expect(answer.agents[0].commands[1]).toBe("openclaw channels add relay --token <token> --base-url https://api.staging.relayapp.im");
    expect([...f.stdout, ...f.stderr].join("")).not.toContain(token);
  });

  it("OpenClaw's dry run lists its two commands and no file", async () => {
    const f = await fixture({ isInteractive: false });
    expect(await runCLI(["connect", "openclaw", "--dry-run", "--json", "--non-interactive"], f.deps)).toBe(0);
    const answer = JSON.parse(f.stdout.join(""));
    expect(answer.agents[0]).toEqual({
      agent: "openclaw",
      files: [],
      commands: [
        "openclaw plugins install @relaymessenger/openclaw-plugin@staging --force --accept-capabilities",
        "openclaw channels add relay --token <token> --base-url <api url>",
      ],
    });
    expect(answer.steps).toEqual([
      "run  openclaw plugins install @relaymessenger/openclaw-plugin@staging --force --accept-capabilities",
      "run  openclaw channels add relay  (the token goes to OpenClaw's own channel store)",
      "restart the OpenClaw gateway when you are ready",
    ]);
  });

  it("a failed OpenClaw command names the command without the token", async () => {
    const f = await fixture({}, runtimes({ openclaw: { found: true, executable: "/fake/bin/openclaw" } }));
    f.runCommand.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "channel refused\n" });
    expect(await runCLI(["connect", "openclaw", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(1);
    const said = f.stderr.join("");
    expect(said).toContain("openclaw channels add relay --token <token> --base-url https://api.staging.relayapp.im did not finish. It said: channel refused");
    expect(said).not.toContain(token);
  });
});

describe("with no terminal", () => {
  const headless = { isInteractive: false } as const;

  it("nothing named exits 2 with the no-TTY sentence and its next step, in words and in JSON", async () => {
    const f = await fixture(headless);
    expect(await runCLI(["connect"], f.deps)).toBe(2);
    expect(f.stderr.join("")).toBe(`Error: ${NO_TTY_SENTENCE} ${NO_TTY_NEXT_STEP}\n`);
    expect(f.prompts.select).not.toHaveBeenCalled();
    const j = await fixture(headless);
    expect(await runCLI(["connect", "--json"], j.deps)).toBe(2);
    expect(JSON.parse(j.stderr.join(""))).toEqual({ error: `${NO_TTY_SENTENCE} ${NO_TTY_NEXT_STEP}`, code: "not_a_tty", next_step: NEXT_STEP.not_a_tty });
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
    expect(Object.keys(answer).sort()).toEqual(["code", "error", "next_step"]);
    expect(answer.error).toContain("Relay cannot ask which agent to connect");
    expect(answer.error).toContain("--token <token>");
    expect(answer.next_step).toBe(NEXT_STEP.not_a_tty);
  });

  it("-y is --yes", async () => {
    const f = await fixture(headless, runtimes());
    const method = codingAgent("vscode").connect;
    if (method.kind !== "mcp-file") throw new Error("Expected a file connector");
    const file = method.file({ home: f.home, env: f.env, platform: process.platform });
    expect(await runCLI(["connect", "vscode", "--token", token, "-y", "--no-skill"], f.deps)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).servers.relay.command).toBe("npx");
  });
});

describe("connect first reply proof", () => {
  it.each([undefined, "/fake/bin/target"])("starts a fake command target and prints its reply (executable=%s)", async (executable) => {
    const definition = codingAgent("cursor");
    const previous = definition.start;
    definition.start = { kind: "command", command: "fake-target", args: ["--relay"], prompt: "Start fake target now?" };
    try {
      const f = await fixture({}, runtimes({ cursor: { found: true, ...(executable ? { executable } : {}) } }));
      let emit: Parameters<TerminalObserver["run"]>[0]["onEvent"];
      f.deps.connect!.observer = () => ({
        semantics: "observational-no-ack",
        run: async (input) => {
          emit = input.onEvent;
        },
      });
      f.startCommand.mockImplementation(async () => {
        emit({ event_type: "message.sent", data: { sender_handle: { handle: card.handle }, parts: [{ type: "text", value: "fake answer" }] } } as never);
        expect(f.stdout.join("")).not.toContain("Answered from your phone:");
        return 0;
      });
      expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
      // The plan said what starts and Continue took it; nothing asks again.
      expect(f.prompts.confirm).not.toHaveBeenCalledWith("Start fake target now?");
      expect(f.startCommand).toHaveBeenCalledExactlyOnceWith(executable ?? "fake-target", ["--relay"]);
      expect(f.stdout.join("")).toContain("Answered from your phone: fake answer");
    } finally {
      if (previous) definition.start = previous; else delete definition.start;
    }
  });

  it("prints a fake restart instruction and waits for the bounded reply", async () => {
    const definition = codingAgent("cursor");
    const previous = definition.start;
    definition.start = { kind: "restart", instruction: "Restart Fake App to load Relay." };
    try {
      const f = await fixture();
      const run = vi.fn(async (input: Parameters<TerminalObserver["run"]>[0]) => {
        expect(f.stdout.join("")).toContain("Restart Fake App to load Relay.");
        await new Promise<void>(resolve => {
          input.signal.addEventListener("abort", () => resolve(), { once: true });
          void vi.advanceTimersByTimeAsync(300_000);
        });
      });
      f.deps.connect!.observer = () => ({ semantics: "observational-no-ack", run });
      vi.useFakeTimers();
      expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(f.stdout.join("")).toContain("Restart Fake App to load Relay.");
      expect(f.startCommand).not.toHaveBeenCalled();
      expect(f.prompts.confirm).not.toHaveBeenCalled();
      expect(f.stdout.join("")).not.toContain("You might have to restart");
      expect(f.stdout.join("")).toContain(`No reply yet. Run:  relay watch @${card.handle}`);
    } finally {
      vi.useRealTimers();
      if (previous) definition.start = previous; else delete definition.start;
    }
  });

  it("keeps the ready path and reply wait for a target without a start", async () => {
    const definition = codingAgent("cursor");
    const previous = definition.start;
    delete definition.start;
    try {
      const f = await fixture();
      expect(codingAgent("cursor").start).toBeUndefined();
      const run = vi.fn(async (input: Parameters<TerminalObserver["run"]>[0]) => {
        input.onEvent({ event_type: "message.sent", data: { sender_handle: { handle: card.handle }, parts: [{ type: "text", value: "still answers" }] } } as never);
      });
      f.deps.connect!.observer = () => ({ semantics: "observational-no-ack", run });
      expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
      expect(f.stdout.join("")).toContain(SAY_HI);
      expect(f.stdout.join("")).toContain("Answered from your phone: still answers");
      expect(f.prompts.confirm).not.toHaveBeenCalled();
      expect(f.startCommand).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      if (previous) definition.start = previous; else delete definition.start;
    }
  });

  it.each(CODING_AGENT_IDS)("%s prints only this agent's first reply, even with --no-start", async (target) => {
    const f = await fixture();
    const run = vi.fn(async (input: Parameters<TerminalObserver["run"]>[0]) => {
      for (const [kind, handle, text] of [
        ["message.received", "person", "incoming"],
        ["message.sent", "another.dev", "wrong agent"],
        ["message.sent", card.handle, "first answer"],
        ["message.sent", card.handle, "second answer"],
      ]) input.onEvent({ event_type: kind, data: { sender_handle: { handle }, parts: [{ type: "text", value: text }] } } as never);
      expect(input.signal.aborted).toBe(true);
    });
    f.deps.connect!.observer = () => ({ semantics: "observational-no-ack", run });
    expect(await runCLI(["connect", target, "--token", token, "--yes", "--allow", "person", "--no-start", "--no-skill"], f.deps)).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(f.stdout.join("")).toContain(SAY_HI);
    expect(f.stdout.join("")).toContain(`[QR]\nhttps://staging.relayapp.im/@${card.handle}`);
    expect(f.stdout.join("")).toContain("Answered from your phone: first answer");
    expect(f.stdout.join("")).not.toMatch(/wrong agent|incoming|second answer|No reply yet/);
    expect(f.startCommand).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps the terminal silent until foreground start returns (reply=%s)", async (hasReply) => {
    const f = await fixture();
    let emit: Parameters<TerminalObserver["run"]>[0]["onEvent"];
    let stopped = false;
    f.deps.connect!.observer = () => ({
      semantics: "observational-no-ack",
      run: async (input) => {
        emit = input.onEvent;
        await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        stopped = true;
      },
    });
    const order: string[] = [];
    f.deps.stdout = (message) => { f.stdout.push(message); order.push(message.trimEnd()); };
    // The closing sentence goes out on Clack's gutter, not straight to stdout.
    f.prompts.message.mockImplementation((message: string) => { f.stdout.push(`${message}\n`); order.push(message.trimEnd()); });
    f.startCommand.mockImplementation(async () => {
      const before = [...order];
      if (hasReply) emit({ event_type: "message.sent", data: { sender_handle: { handle: card.handle }, parts: [{ type: "text", value: "first answer" }] } } as never);
      await Promise.resolve();
      expect(order).toEqual(before);
      order.push("start returned");
      return 0;
    });
    expect(await runCLI(["connect", "claude", "--token", token, "--yes", "--allow", "person", "--no-skill"], f.deps)).toBe(0);
    expect(f.startCommand).toHaveBeenCalledExactlyOnceWith("/fake/bin/claude", ["--dangerously-load-development-channels", "plugin:relay@relay-messenger"]);
    expect(stopped).toBe(true);
    const outcome = hasReply ? "Answered from your phone: first answer" : `No reply yet. Run:  relay watch @${card.handle}`;
    expect(order.slice(-2)).toEqual(["start returned", outcome]);
    expect(order.filter(line => line === outcome)).toHaveLength(1);
  });

  it("times out after five minutes, exits zero and keeps the connection", async () => {
    const f = await fixture();
    const run = vi.fn(async (input: Parameters<TerminalObserver["run"]>[0]) => {
      await new Promise<void>(resolve => {
        input.signal.addEventListener("abort", () => resolve(), { once: true });
        void vi.advanceTimersByTimeAsync(300_000);
      });
    });
    f.deps.connect!.observer = () => ({ semantics: "observational-no-ack", run });
    vi.useFakeTimers();
    try {
      // VS Code is an mcp-file target with no bridge, so the reply-proof wait
      // (not the bridge) is what runs after connecting.
      const method = codingAgent("vscode").connect;
      if (method.kind !== "mcp-file") throw new Error("Expected a file connector");
      const file = method.file({ home: f.home, env: f.env, platform: process.platform });
      expect(await runCLI(["connect", "vscode", "--token", token, "--yes", "--no-skill"], f.deps)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(f.stdout.join("")).toContain(`No reply yet. Run:  relay watch @${card.handle}`);
      expect(JSON.parse(await readFile(file, "utf8")).servers.relay).toBeDefined();
    } finally { vi.useRealTimers(); }
  });

  it("JSON skips proof without opening an observer", async () => {
    const f = await fixture();
    const observer = vi.fn();
    f.deps.connect!.observer = observer;
    expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(f.stdout.join(""))).toMatchObject({ ok: true, proof: "skipped" });
    expect(observer).not.toHaveBeenCalled();
  });

  it.each([false, true])("skips proof without a terminal or with non-interactive=%s", async (nonInteractive) => {
    const f = await fixture({ isInteractive: nonInteractive });
    const observer = vi.fn();
    f.deps.connect!.observer = observer;
    expect(await runCLI(["connect", "vscode", "--token", token, "--yes", "--no-skill", ...(nonInteractive ? ["--non-interactive"] : [])], f.deps)).toBe(0);
    expect(observer).not.toHaveBeenCalled();
    expect(f.stdout.join("")).toContain(`No reply yet. Run:  relay watch @${card.handle}`);
  });
});
