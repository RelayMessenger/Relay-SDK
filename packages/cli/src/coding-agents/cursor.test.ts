import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import agent from "./cursor.js";

it("connects over the ACP bridge and declares the cursor-agent acp command", () => {
  expect(agent.connect).toEqual({ kind: "acp-bridge" });
  expect(agent.start).toEqual({
    kind: "acp-bridge",
    command: "cursor-agent",
    args: ["acp"],
    prompt: "Answer Relay messages with Cursor from this folder?",
  });
});

it.each([undefined, "/fake/bin/cursor-agent"])("connect drives Cursor over ACP using executable=%s", async (executable) => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const token = `rel_token_${"C".repeat(43)}`;
  const bridge = vi.fn(async (input: { say(line: string): void }) => { input.say("stopped"); });
  const prompts: InteractivePrompts = {
    select: vi.fn(async () => "new"),
    multiselect: vi.fn(async () => ["cursor"]),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => token),
    text: vi.fn(async (_message, initial) => initial),
    info: vi.fn(), intro: vi.fn(), outro: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn(), note: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  };
  const errors: string[] = [];
  expect(await runCLI(["connect", "cursor", "--token", token, "--yes", "--no-skill"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, home, platform: process.platform },
    cwd: home, isInteractive: true, prompts,
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: () => undefined, stderr: (value) => errors.push(value),
    connect: {
      sniff: async () => [{ id: "cursor", label: "Cursor", found: true, ...(executable ? { executable } : {}) }],
      bridge, observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n", pairTimeoutMs: 1, version: "0.1.6-staging.0",
    },
  })).toBe(0);
  expect(errors).toEqual([]);
  expect(bridge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: "acp", command: executable ?? "cursor-agent", acpArgs: ["acp"], label: "Cursor",
    mcpServer: expect.objectContaining({ command: "npx" }),
  }));
});
