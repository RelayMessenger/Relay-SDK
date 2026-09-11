import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "../program.js";
import codex from "./codex.js";

describe("Codex start", () => {
  it("offers the interactive command using the saved MCP config", () => {
    expect(codex.start).toEqual({
      kind: "command",
      command: "codex",
      args: [],
      prompt: "Start Codex with Relay now?",
    });
  });

  it.each(["/detected/bin/codex", undefined])("resolves executable %s through connect", async (executable) => {
    const home = await mkdtemp("/tmp/target-start-codex-20260911/connect-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCLI(["connect", "codex", "--new", "--yes", "--no-skill", "--json"], {
      configContext: { home, platform: "darwin", env: { PATH: "", RELAY_CONFIG_PATH: join(home, "config.json") } },
      cwd: home,
      isInteractive: false,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      fetch: vi.fn(async () => Response.json({
        agent: { handle: "codex_test.dev", first_name: "Codex", last_name: null, image_url: null, kind: "agent", is_active: true },
        secret: `rly_live_${"C".repeat(43)}`,
        share_url: "https://relayapp.im/@codex_test.dev",
      }, { status: 201 })),
      connect: {
        sniff: async () => [{ id: "codex", label: "Codex", found: true, ...(executable ? { executable } : {}) }],
        runCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      },
    });
    expect(code, stderr.join("")).toBe(0);
    expect(JSON.parse(stdout.join("")).agents[0].start_command).toBe(executable ?? "codex");
  });
});
