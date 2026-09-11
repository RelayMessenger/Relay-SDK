import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import agent from "./cline.js";

it("connects over the ACP bridge with Cline's confirmed --acp command", () => {
  expect(agent.connect).toEqual({ kind: "acp-bridge" });
  // `cline --acp` is Cline's own documented ACP launch (docs.cline.bot/usage/acp).
  expect(agent.start).toEqual({
    kind: "acp-bridge",
    command: "cline",
    args: ["--acp"],
    prompt: "Answer Relay messages with Cline from this folder?",
  });
});

it("connect starts Cline over its ACP bridge", async () => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const token = `rly_live_${"C".repeat(43)}`;
  const bridge = vi.fn(async () => undefined);
  const stdout: string[] = [];
  const prompts: InteractivePrompts = {
    select: vi.fn(async () => "new"),
    multiselect: vi.fn(async () => ["cline"]),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => token),
    text: vi.fn(async (_message, initial) => initial),
    info: vi.fn(), intro: vi.fn(), outro: vi.fn(),
    step: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  };
  expect(await runCLI(["connect", "cline", "--token", token, "--yes", "--no-skill"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, home, platform: process.platform },
    cwd: home, isInteractive: true, prompts,
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: (value) => stdout.push(value), stderr: () => undefined,
    connect: {
      sniff: async () => [{ id: "cline", label: "Cline", found: true }],
      bridge, observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n", pairTimeoutMs: 1, version: "0.1.6-staging.0",
    },
  })).toBe(0);
  expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ command: "cline", acpArgs: ["--acp"], kind: "acp" }));
});
