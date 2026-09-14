import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCLI } from "../program.js";
import agent from "./openclaw.js";

it("declares the OpenClaw gateway start command", () => {
  expect(agent.start).toEqual({
    kind: "command",
    command: "openclaw",
    args: ["gateway"],
    prompt: "Start OpenClaw with Relay now?",
  });
});

it.each([undefined, "/fake/bin/openclaw"])("connect resolves the gateway executable (%s)", async (executable) => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const stdout: string[] = [];
  const startCommand = vi.fn(async () => 0);
  const code = await runCLI(["connect", "openclaw", "--token", `rel_token_${"C".repeat(43)}`, "--yes", "--no-skill", "--json", "--non-interactive"], {
    configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, platform: process.platform },
    cwd: home,
    isInteractive: false,
    stdout: (value) => stdout.push(value),
    stderr: () => undefined,
    fetch: async () => Response.json({ contact_cards: [{ handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] }),
    connect: {
      sniff: async () => [{ id: "openclaw", label: "OpenClaw", found: true, ...(executable ? { executable } : {}) }],
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      startCommand,
    },
  });
  expect(code).toBe(0);
  expect(JSON.parse(stdout.join("")).agents[0].start_command).toBe(`${executable ?? "openclaw"} gateway`);
  expect(startCommand).not.toHaveBeenCalled();
});
