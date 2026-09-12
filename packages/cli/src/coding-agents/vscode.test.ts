import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import type { TerminalObserver } from "../terminal-watch.js";
import agent from "./vscode.js";

it("declares the VS Code restart instruction", () => {
  expect(agent.start).toEqual({
    kind: "restart",
    instruction: "Restart VS Code to load Relay, then ask it to read your Relay messages.",
  });
});

it("connect prints the VS Code restart instruction and waits for the bounded reply", async () => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const stdout: string[] = [];
  const token = `rly_live_${"C".repeat(43)}`;
  const startCommand = vi.fn(async () => 0);
  const instruction = "Restart VS Code to load Relay, then ask it to read your Relay messages.";
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
    success: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    message: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    note: vi.fn((message: string, title: string) => { stdout.push(`${title}\n${message}\n`); }),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn((message: string) => { stdout.push(`${message}\n`); }) })),
  } satisfies InteractivePrompts;
  const run = vi.fn(async (input: Parameters<TerminalObserver["run"]>[0]) => {
    expect(stdout.join("")).toContain(instruction);
    await new Promise<void>(resolve => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
      void vi.advanceTimersByTimeAsync(300_000);
    });
  });
  vi.useFakeTimers();
  try {
    const code = await runCLI(["connect", "vscode", "--token", token, "--yes", "--no-skill"], {
      configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, platform: process.platform },
      cwd: home,
      isInteractive: true,
      prompts,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      fetch: async () => Response.json({ contact_cards: [{ handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] }),
      connect: {
        sniff: async () => [{ id: "vscode", label: "VS Code", found: true }],
        startCommand,
        observer: () => ({ semantics: "observational-no-ack", run }),
        renderQR: () => "[QR]\n",
      },
    });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(stdout.join("")).toContain(instruction);
    expect(stdout.join("")).not.toContain("You might have to restart");
    expect(startCommand).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain("No reply yet. Run:  relay watch @calm_cangoo.dev");
  } finally {
    vi.useRealTimers();
  }
});
