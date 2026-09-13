import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCLI } from "../program.js";
import type { InteractivePrompts } from "../interactive.js";
import agent from "./hermes.js";

it("starts the Hermes gateway with the Relay prompt", () => {
  expect(agent.start).toEqual({
    kind: "command",
    command: "hermes",
    args: ["gateway", "run"],
    prompt: "Start Hermes Agent with Relay now?",
  });
});

it.each([undefined, "/fake/bin/hermes"])("resolves the Hermes executable (%s)", async (executable) => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const startCommand = vi.fn(async () => 0);
  const prompts = {
    select: vi.fn(async () => "new"),
    multiselect: vi.fn(async () => ["hermes"]),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => ""),
    text: vi.fn(async () => ""),
    info: vi.fn(), intro: vi.fn(), outro: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn(), note: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  } satisfies InteractivePrompts;
  const code = await runCLI(["connect", "hermes", "--token", `rel_token_${"C".repeat(43)}`, "--yes", "--no-skill"], {
    configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, platform: process.platform },
    cwd: home,
    isInteractive: true,
    prompts,
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "test.dev", first_name: "Test", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: vi.fn(), stderr: vi.fn(),
    connect: {
      sniff: async () => [{ id: "hermes", label: "Hermes", found: true, ...(executable ? { executable } : {}) }],
      runCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      startCommand,
      observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n",
      pairTimeoutMs: 1,
    },
  });
  expect(code).toBe(0);
  // The plan's last line said the gateway starts, and Continue took it; nothing asks again.
  expect(prompts.confirm).not.toHaveBeenCalledWith("Start Hermes Agent with Relay now?");
  expect(startCommand).toHaveBeenCalledExactlyOnceWith(executable ?? "hermes", ["gateway", "run"]);
});
