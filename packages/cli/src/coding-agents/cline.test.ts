import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import type { TerminalObserver } from "../terminal-watch.js";
import agent from "./cline.js";

const instruction = "Restart your editor so Cline loads Relay, then ask Cline to read your Relay messages.";

it("declares the Cline editor restart instruction", () => {
  expect(agent.start).toEqual({ kind: "restart", instruction });
});

it("connect prints the Cline restart instruction and waits for the bounded reply", async () => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const stdout: string[] = [];
  const token = `rly_live_${"C".repeat(43)}`;
  const startCommand = vi.fn(async () => 0);
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
  const run = vi.fn(async (input: Parameters<TerminalObserver["run"]>[0]) => {
    expect(stdout.join("")).toContain(instruction);
    await new Promise<void>(resolve => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
      void vi.advanceTimersByTimeAsync(300_000);
    });
  });
  try {
    vi.useFakeTimers();
    const code = await runCLI(["connect", "cline", "--token", token, "--yes", "--no-skill"], {
      configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, platform: process.platform },
      cwd: home,
      isInteractive: true,
      prompts,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      fetch: async () => Response.json({ contact_cards: [{ handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] }),
      connect: {
        sniff: async () => [{ id: "cline", label: "Cline", found: true }],
        runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
        startCommand,
        observer: () => ({ semantics: "observational-no-ack", run }),
      },
    });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(stdout.join("")).toContain(instruction);
    expect(stdout.join("")).not.toContain("You might have to restart");
    expect(stdout.join("")).toContain("No reply yet. Run:  relay watch @calm_cangoo.dev");
    expect(startCommand).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
