import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCLI } from "./program.js";
import { readConfig } from "./config.js";

it.each([
  ["agents", "create"],
  ["connect", "codex", "--new", "--yes", "--no-start", "--no-skill", "--allow", "fixture"],
])("requires Console auth instead of anonymous creation: %j", async (...args) => {
  const home = await mkdtemp(join(tmpdir(), "relay-no-anonymous-"));
  try {
    const context = { home, cwd: home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" } };
    const fetch = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    const runCommand = vi.fn();
    const output: string[] = [];
    expect(await runCLI(["--json", "--no-input", ...args], {
      configContext: context, cwd: home, isInteractive: false, fetch,
      stdout: (value) => output.push(value), stderr: (value) => output.push(value),
      connect: {
        sniff: async () => [{ id: "codex", label: "Codex", found: true, executable: "/fixture/codex" }],
        runCommand,
      },
    })).toBe(4);
    expect(fetch).not.toHaveBeenCalled();
    expect(output.join(" ")).toContain("Not signed in.");
    expect(runCommand).not.toHaveBeenCalled();
    expect(Object.values((await readConfig(context)).profiles).every(profile => !profile.agent_token)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
