import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCLI } from "../program.js";
import gemini from "./gemini-cli.js";

it("starts Gemini CLI interactively with its registered MCP configuration", () => {
  expect(gemini.start).toEqual({
    kind: "command",
    command: "gemini",
    args: [],
    prompt: "Start Gemini CLI with Relay now?",
  });
});

it.each([undefined, "/fake/bin/gemini"])("connect starts Gemini using executable=%s", async (executable) => {
  const scratch = "/tmp/target-start-gemini-cli-20260911";
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const stderr = vi.fn();
  const confirm = vi.fn(async () => true);
  const startCommand = vi.fn(async () => 0);
  const token = `rly_live_${"C".repeat(43)}`;
  const code = await runCLI(["connect", "gemini-cli", "--token", token, "--yes", "--no-skill"], {
    configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, platform: process.platform },
    cwd: home,
    isInteractive: true,
    prompts: {
      select: vi.fn(async () => "new"),
      multiselect: vi.fn(async () => ["gemini-cli"]),
      confirm,
      password: vi.fn(async () => token),
      text: vi.fn(async () => "gemini-test"),
      info: vi.fn(),
      intro: vi.fn(),
      outro: vi.fn(),
      step: vi.fn(),
      spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    },
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "gemini-test", first_name: "Gemini", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: vi.fn(),
    stderr,
    connect: {
      sniff: async () => [{ id: "gemini-cli", label: "Gemini CLI", found: true, ...(executable ? { executable } : {}) }],
      runCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      startCommand,
      observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n",
      pairTimeoutMs: 10,
      version: "0.1.6-staging.0",
    },
  });
  expect(code, JSON.stringify(stderr.mock.calls)).toBe(0);
  expect(confirm).toHaveBeenCalledWith("Start Gemini CLI with Relay now?");
  expect(startCommand).toHaveBeenCalledExactlyOnceWith(executable ?? "gemini", []);
});
