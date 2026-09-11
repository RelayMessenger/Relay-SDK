import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import agent from "./cline.js";

it("connects over the ACP bridge, but its ACP command is not confirmed yet", () => {
  expect(agent.connect).toEqual({ kind: "acp-bridge" });
  // No `args`: Cline's exact ACP launch flag is not confirmed from any source,
  // so the bridge is wired but not started (a TODO, not a guess).
  expect(agent.start).toEqual({
    kind: "acp-bridge",
    command: "cline",
    prompt: "Answer Relay messages with Cline from this folder?",
  });
  if (agent.start?.kind !== "acp-bridge") throw new Error("Expected an acp-bridge start");
  expect(agent.start.args).toBeUndefined();
});

it("connect wires Cline to the bridge but does not start it, and says so", async () => {
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
  expect(bridge).not.toHaveBeenCalled();
  expect(stdout.join("")).toContain("Cline's ACP command is not confirmed yet, so Relay did not start it.");
});
