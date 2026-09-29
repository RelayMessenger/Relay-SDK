import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProgram, runCLI } from "./program.js";
import { validateFirstName, validateHandle } from "./agents.js";
import { handleFromName } from "./connect.js";

it("creation uses a local handle part and the existing 30-character name cap", () => {
  expect(validateHandle("my_agent")).toBe("my_agent");
  expect(handleFromName("My Agent")).toBe("my_agent");
  expect(validateFirstName(`  ${"N".repeat(30)}  `)).toBe("N".repeat(30));
  expect(() => validateFirstName("N".repeat(31))).toThrow("1 to 30");
  for (const value of ["my_agent.dev", "My_Agent", "@my_agent", "ab", `a${"b".repeat(32)}`]) {
    expect(() => validateHandle(value)).toThrow("A handle is one word");
  }
});

it.each([
  ["agents", "create", "--subtitle", "Helps with tasks", "--handle", "my_agent.acme"],
  ["agents", "create", "--subtitle", "Helps with tasks", "--handle", "My_Agent"],
  ["agents", "create", "--subtitle", "Helps with tasks", "--name", "N".repeat(31)],
  ["connect", "codex", "--subtitle", "Helps with tasks", "--new", "--yes", "--handle", "My_Agent"],
  ["connect", "codex", "--subtitle", "Helps with tasks", "--new", "--yes", "--name", "N".repeat(31)],
])("rejects invalid creation input before OAuth/network: %j", async (...args) => {
  const home = await mkdtemp(join(tmpdir(), "relay-creation-contract-"));
  try {
    const fetch = vi.fn();
    const consoleLogin = vi.fn();
    expect(await runCLI(["--json", "--no-input", ...args], {
      configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json") } },
      cwd: home, isInteractive: false, fetch, consoleLogin,
      stdout: () => undefined, stderr: () => undefined,
    })).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleLogin).not.toHaveBeenCalled();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("does not advertise or accept the obsolete token-name option", async () => {
  const program = createProgram();
  const create = program.commands.find(c => c.name() === "agents")!.commands.find(c => c.name() === "create")!;
  const connect = program.commands.find(c => c.name() === "connect")!;
  expect(create.options.some(option => option.long === "--token-name")).toBe(false);
  expect(create.helpInformation()).not.toContain("--token-name");
  expect(create.helpInformation()).toContain("the agent's handle");
  expect(connect.helpInformation()).toContain("the agent's handle");
  const fetch = vi.fn(), consoleLogin = vi.fn();
  expect(await runCLI(["--json", "--no-input", "agents", "create", "--subtitle", "Helps with tasks", "--token-name", "old"], {
    fetch, consoleLogin, stdout: () => undefined, stderr: () => undefined,
  })).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(consoleLogin).not.toHaveBeenCalled();
});
