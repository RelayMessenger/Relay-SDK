import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCLI } from "../program.js";
import type { InteractivePrompts } from "../interactive.js";
import agent from "./opencode.js";

it("starts OpenCode with its configured MCP servers and the requested prompt", () => {
  expect(agent.start).toEqual({
    kind: "command",
    command: "opencode",
    args: [],
    prompt: "Start OpenCode with Relay now?",
  });
});

it.each([undefined, "/fake/bin/opencode"])("connect resolves the executable (%s) and asks to start", async (executable) => {
  const scratch = "/tmp/target-start-opencode-20260911";
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const token = `rly_live_${"C".repeat(43)}`;
  const prompts: InteractivePrompts = {
    select: vi.fn(async () => "new"),
    multiselect: vi.fn(async () => ["opencode"]),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => token),
    text: vi.fn(async (_message, initial) => initial),
    info: vi.fn(), intro: vi.fn(), outro: vi.fn(), step: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  };
  const startCommand = vi.fn(async () => {
    const config = JSON.parse(await readFile(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    expect(config.mcp.relay).toMatchObject({ type: "local", enabled: true });
    return 0;
  });
  const errors: string[] = [];
  expect(await runCLI(["connect", "opencode", "--token", token, "--yes", "--no-skill"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, home, platform: "linux" },
    cwd: home, isInteractive: true, prompts,
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: () => undefined, stderr: (value) => errors.push(value),
    connect: {
      sniff: async () => [{ id: "opencode", label: "OpenCode", found: true, ...(executable ? { executable } : {}) }],
      startCommand,
      observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n", pairTimeoutMs: 1, version: "0.1.6-staging.0",
    },
  })).toBe(0);
  expect(errors).toEqual([]);
  expect(prompts.confirm).toHaveBeenCalledWith("Start OpenCode with Relay now?");
  expect(startCommand).toHaveBeenCalledExactlyOnceWith(executable ?? "opencode", []);
});
