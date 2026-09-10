import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { commandRows, everythingElseHelp, HELP_GROUPS } from "./help-groups.js";
import { createProgram, runCLI } from "./program.js";
import { relaySkillGlobalArgs } from "./skill-offer.js";
import { skillTargets, drivingAgent, drivingAgentHint } from "./agent-driver.js";

const program = () => createProgram({});

async function printedHelp(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "relay-help-"));
  const printed: string[] = [];
  await runCLI(["--help"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, home },
    isInteractive: false,
    stdout: (value) => printed.push(value), stderr: (value) => printed.push(value),
  });
  return printed.join("");
}

it("every command in the tree says what it does", () => {
  const rows = commandRows(program());
  const undescribed = rows.filter((row) => !row.description.trim()).map((row) => row.path);
  // The guard that can fail: one command added without a description turns this red.
  expect(undescribed).toEqual([]);
  expect(rows.length).toBeGreaterThan(50);
});

it("a description is a sentence, not a repeat of the command's own name", () => {
  for (const row of commandRows(program())) {
    const last = row.path.split(" ").at(-1)!;
    expect(row.description.trim().toLowerCase(), row.path).not.toBe(last);
    expect(row.description.trim().length, row.path).toBeGreaterThan(9);
  }
});

it("the help is three groups, and Get started holds only connect", () => {
  const root = program();
  const groups = new Map<string, string[]>();
  for (const command of root.commands) {
    const group = command.helpGroup();
    groups.set(group, [...(groups.get(group) ?? []), command.name()]);
  }
  expect(groups.get(HELP_GROUPS.getStarted)).toEqual(["connect"]);
  expect(groups.get(HELP_GROUPS.everyDay)).toEqual(["watch", "doctor", "agents"]);
  expect(groups.get(HELP_GROUPS.everythingElse)).toContain("chats");
  // The older name is reachable and described, and named nowhere in the help.
  expect(groups.get(HELP_GROUPS.unlisted)).toEqual(["events"]);
  // The names line is built from the program, so nothing can fall out of it.
  for (const name of groups.get(HELP_GROUPS.everythingElse) ?? []) {
    expect(everythingElseHelp(root)).toContain(name);
  }
});

it("--help prints the three headings and the one line that replaces the rest", async () => {
  const help = await printedHelp();
  expect(help).toContain("Get started:");
  expect(help).toContain("Every day:");
  expect(help).toContain("Everything else:");
  expect(help).toContain("run  relaymessenger help <command>  for any of these");
  expect(help).toContain("No environment variables are needed.");
  // The older name is described and reachable, and listed nowhere.
  expect(help).not.toMatch(/^\s*events\b/mu);
  expect(help).not.toContain("contact-requests");
});

it("connect is the only thing a new person is shown first", () => {
  const help = program().helpInformation();
  const getStarted = help.indexOf("Get started:");
  const everyDay = help.indexOf("Every day:");
  expect(getStarted).toBeGreaterThan(-1);
  expect(help.slice(getStarted, everyDay)).toContain("connect");
  expect(help.slice(getStarted, everyDay)).not.toContain("agents");
});

it("the deleted surfaces are gone from the tree", () => {
  const paths = commandRows(program()).map((row) => row.path);
  expect(paths).not.toContain("contact-requests");
  expect(paths).not.toContain("contact-requests create");
  const flags = program().commands
    .flatMap((command) => [command, ...command.commands])
    .flatMap((command) => command.options.map((option) => option.long ?? ""));
  for (const removed of [
    "--connect", "--runtime-home", "--runtime-config", "--runtime-state-dir",
    "--runtime-account", "--runtime-brain", "--runtime-context",
    "--confirm-configure", "--runtime-stopped",
  ]) {
    expect(flags, removed).not.toContain(removed);
  }
});

it("contact-requests answers as an unknown command, and reaches no Relay call", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-help-groups-"));
  const fetch = vi.fn(async () => Response.json({ contact_cards: [] }));
  const output: string[] = [];
  const code = await runCLI(["contact-requests", "create", "advait"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_AGENT_TOKEN: "rly_test_token_value" }, home },
    isInteractive: false, fetch,
    stdout: (value) => output.push(value), stderr: (value) => output.push(value),
  });
  expect(code).not.toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("--install-skills targets this computer's agents and answers the installer itself", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-install-skills-"));
  expect(await skillTargets(home, {})).toEqual(["cline"]);
  expect(await skillTargets(home, { CLAUDE_CONFIG_DIR: home })).toEqual(["cline", "claude-code"]);
  const args = relaySkillGlobalArgs(["cline", "claude-code"], "0.1.6-staging.0");
  expect(args).toEqual([
    "--yes", "skills@1.5.25", "add",
    "https://github.com/RelayMessenger/Relay-SDK/tree/staging/skills/relay",
    "--skill", "relay", "--global", "--yes",
    "--agent", "cline", "--agent", "claude-code",
  ]);
  const skillInstaller = vi.fn(async () => undefined);
  const output: string[] = [];
  const code = await runCLI(["--install-skills"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, home },
    isInteractive: false, skillInstaller,
    stdout: (value) => output.push(value), stderr: (value) => output.push(value),
  });
  expect(code).toBe(0);
  expect(skillInstaller).toHaveBeenCalledOnce();
});

it("an agent driving the command is seen by its own variable", () => {
  expect(drivingAgent({})).toBeUndefined();
  expect(drivingAgent({ CLAUDECODE: "1" })).toEqual({ name: "Claude Code", variable: "CLAUDECODE" });
  expect(drivingAgent({ CURSOR_CLI: "1" })).toMatchObject({ name: "Cursor" });
  expect(drivingAgent({ CODEX_HOME: "/home/dev/.codex" })).toMatchObject({ name: "Codex" });
  expect(drivingAgent({ CLAUDECODE: "  " })).toBeUndefined();
  expect(drivingAgentHint({ name: "Claude Code", variable: "CLAUDECODE" })).toContain("asks nothing");
});

it("an agent driving the command gets no menu, and one line saying why", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-driving-"));
  const select = vi.fn(async () => "exit");
  const stderr: string[] = [];
  const code = await runCLI([], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), CLAUDECODE: "1" }, home },
    isInteractive: true,
    prompts: {
      select, confirm: vi.fn(async () => false), password: vi.fn(async () => ""),
      text: vi.fn(async () => ""), info: vi.fn(), intro: vi.fn(), outro: vi.fn(),
      step: vi.fn(), spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    },
    stdout: () => undefined, stderr: (value) => stderr.push(value),
  });
  expect(code).toBe(0);
  expect(select).not.toHaveBeenCalled();
  expect(stderr.join("")).toContain("Relay sees Claude Code (CLAUDECODE)");
});
