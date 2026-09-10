import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claudeChannelDir, claudeConfigDir, findExecutable, normalizeRuntimeChoice, runtimeConfigPath, sniffRuntimes } from "./runtime-sniff.js";

const home = async (): Promise<string> => mkdtemp(join(tmpdir(), "relay-sniff-home-"));

async function fakeCommand(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

it("finds nothing in an empty home with an empty PATH", async () => {
  const runtimes = await sniffRuntimes({ env: { PATH: "" }, home: await home(), platform: "linux" });
  expect(runtimes.map((runtime) => runtime.id)).toEqual(["claude", "hermes", "openclaw"]);
  expect(runtimes.every((runtime) => !runtime.found)).toBe(true);
  expect(runtimes.map((runtime) => runtime.supported)).toEqual([true, false, false]);
});

it("a command on PATH is enough, and so is the runtime's own folder", async () => {
  const root = await home();
  const bin = join(root, "bin");
  const executable = await fakeCommand(bin, "claude");
  await mkdir(join(root, ".hermes"), { recursive: true });
  const found = await sniffRuntimes({ env: { PATH: bin }, home: root, platform: "linux" });
  const claude = found.find((runtime) => runtime.id === "claude")!;
  const hermes = found.find((runtime) => runtime.id === "hermes")!;
  const openclaw = found.find((runtime) => runtime.id === "openclaw")!;
  expect(claude).toMatchObject({ found: true, executable });
  expect(claude.configPath).toBeUndefined();
  expect(hermes).toMatchObject({ found: true, configPath: join(root, ".hermes") });
  expect(hermes.executable).toBeUndefined();
  expect(openclaw.found).toBe(false);
});

it("OpenClaw counts only when its own config file is there, not just its folder", async () => {
  const root = await home();
  await mkdir(join(root, ".openclaw"), { recursive: true });
  expect((await sniffRuntimes({ env: { PATH: "" }, home: root, platform: "linux" }))
    .find((runtime) => runtime.id === "openclaw")!.found).toBe(false);
  await writeFile(join(root, ".openclaw", "openclaw.json"), "{}");
  expect((await sniffRuntimes({ env: { PATH: "" }, home: root, platform: "linux" }))
    .find((runtime) => runtime.id === "openclaw")!.found).toBe(true);
});

it("selected homes replace the default ones, and never add to them", async () => {
  const root = await home();
  const selected = join(root, "selected-claude");
  const hermesHome = join(root, "selected-hermes");
  await mkdir(selected, { recursive: true });
  await mkdir(join(root, ".claude"), { recursive: true });
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: selected }, root)).toBe(selected);
  expect(claudeConfigDir({}, root)).toBe(join(root, ".claude"));
  expect(claudeChannelDir({ CLAUDE_CONFIG_DIR: selected }, root)).toBe(join(selected, "channels", "relay"));
  expect(claudeChannelDir({ RELAY_CHANNEL_DIR: "/somewhere/else" }, root)).toBe("/somewhere/else");
  expect(runtimeConfigPath("hermes", { env: { HERMES_HOME: hermesHome }, home: root })).toBe(hermesHome);
  // The default home holds a folder; the selected one does not, so nothing is found.
  const found = await sniffRuntimes({ env: { PATH: "", CLAUDE_CONFIG_DIR: join(root, "absent") }, home: root, platform: "linux" });
  expect(found.find((runtime) => runtime.id === "claude")!.found).toBe(false);
});

it("only absolute PATH entries are searched", async () => {
  const root = await home();
  const bin = join(root, "bin");
  await fakeCommand(bin, "hermes");
  expect(await findExecutable("hermes", { PATH: "relative/bin" }, "linux")).toBeUndefined();
  expect(await findExecutable("hermes", { PATH: `relative/bin:${bin}` }, "linux")).toBe(join(bin, "hermes"));
  expect(await findExecutable("absent", { PATH: bin }, "linux")).toBeUndefined();
});

it("accepts the short word a person types and refuses anything else", () => {
  expect(normalizeRuntimeChoice("claude")).toBe("claude");
  expect(normalizeRuntimeChoice("Claude-Code")).toBe("claude");
  expect(normalizeRuntimeChoice(" hermes ")).toBe("hermes");
  expect(normalizeRuntimeChoice("openclaw")).toBe("openclaw");
  expect(normalizeRuntimeChoice("sdk")).toBe("other");
  expect(normalizeRuntimeChoice("nonsense")).toBeUndefined();
});
