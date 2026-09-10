import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { CODING_AGENT_IDS } from "./coding-agents.js";
import { claudeChannelDir, claudeConfigDir, findExecutable, sniffRuntimes } from "./runtime-sniff.js";

const home = async (): Promise<string> => mkdtemp(join(tmpdir(), "relay-sniff-home-"));

async function fakeCommand(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

it("finds nothing in an empty home with an empty PATH, and lists the registry in order", async () => {
  const runtimes = await sniffRuntimes({ env: { PATH: "" }, home: await home(), platform: "linux" });
  expect(runtimes.map((runtime) => runtime.id)).toEqual(CODING_AGENT_IDS);
  expect(runtimes.every((runtime) => !runtime.found)).toBe(true);
});

it("a command on PATH is enough, and so is the agent's own folder", async () => {
  const root = await home();
  const bin = join(root, "bin");
  const executable = await fakeCommand(bin, "claude");
  await mkdir(join(root, ".hermes"), { recursive: true });
  const found = await sniffRuntimes({ env: { PATH: bin }, home: root, platform: "linux" });
  const claude = found.find((runtime) => runtime.id === "claude-code")!;
  const hermes = found.find((runtime) => runtime.id === "hermes")!;
  const openclaw = found.find((runtime) => runtime.id === "openclaw")!;
  expect(claude).toMatchObject({ found: true, executable, label: "Claude Code" });
  expect(claude.configPath).toBeUndefined();
  expect(hermes).toMatchObject({ found: true, configPath: join(root, ".hermes") });
  expect(hermes.executable).toBeUndefined();
  expect(openclaw.found).toBe(false);
});

// The paths are the page's section 2: Docker's installCheckPaths and Vercel's
// detect(home). One folder per agent, under the home this command was given.
it.each([
  ["codex", [".codex"]],
  ["cursor", [".cursor"]],
  ["opencode", [".config", "opencode"]],
  ["cline", [".cline"]],
  ["vscode", [".config", "Code"]],
  ["gemini-cli", [".gemini"]],
  ["hermes", [".hermes"]],
  ["openclaw", [".openclaw"]],
] as const)("%s is installed when its folder exists under home", async (id, parts) => {
  const root = await home();
  const before = await sniffRuntimes({ env: { PATH: "" }, home: root, platform: "linux" });
  expect(before.find((runtime) => runtime.id === id)!.found).toBe(false);
  await mkdir(join(root, ...parts), { recursive: true });
  const after = await sniffRuntimes({ env: { PATH: "" }, home: root, platform: "linux" });
  expect(after.find((runtime) => runtime.id === id)).toMatchObject({ found: true, configPath: join(root, ...parts) });
});

it("Claude Desktop and VS Code on Windows are found by their %APPDATA% folders", async () => {
  const root = await home();
  const appData = join(root, "AppData", "Roaming");
  await mkdir(join(appData, "Claude"), { recursive: true });
  await mkdir(join(appData, "Code"), { recursive: true });
  const found = await sniffRuntimes({ env: { PATH: "", APPDATA: appData }, home: root, platform: "win32" });
  expect(found.find((runtime) => runtime.id === "claude-desktop")).toMatchObject({ found: true, configPath: join(appData, "Claude") });
  expect(found.find((runtime) => runtime.id === "vscode")).toMatchObject({ found: true, configPath: join(appData, "Code") });
});

it("selected homes replace the default ones, and never add to them", async () => {
  const root = await home();
  const selected = join(root, "selected-claude");
  const codexHome = join(root, "selected-codex");
  await mkdir(selected, { recursive: true });
  await mkdir(join(root, ".claude"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: selected }, root)).toBe(selected);
  expect(claudeConfigDir({}, root)).toBe(join(root, ".claude"));
  expect(claudeChannelDir({ CLAUDE_CONFIG_DIR: selected }, root)).toBe(join(selected, "channels", "relay"));
  expect(claudeChannelDir({ RELAY_CHANNEL_DIR: "/somewhere/else" }, root)).toBe("/somewhere/else");
  // The default homes hold folders; the selected ones do not, so nothing is found.
  const found = await sniffRuntimes({ env: { PATH: "", CLAUDE_CONFIG_DIR: join(root, "absent"), CODEX_HOME: codexHome }, home: root, platform: "linux" });
  expect(found.find((runtime) => runtime.id === "claude-code")!.found).toBe(false);
  expect(found.find((runtime) => runtime.id === "codex")!.found).toBe(false);
});

it("only absolute PATH entries are searched", async () => {
  const root = await home();
  const bin = join(root, "bin");
  await fakeCommand(bin, "hermes");
  expect(await findExecutable("hermes", { PATH: "relative/bin" }, "linux")).toBeUndefined();
  expect(await findExecutable("hermes", { PATH: `relative/bin${delimiter}${bin}` }, "linux")).toBe(join(bin, "hermes"));
  expect(await findExecutable("absent", { PATH: bin }, "linux")).toBeUndefined();
});
