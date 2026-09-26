import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import agent, { clineMcpSettings } from "./cline.js";

it("finds cline_mcp_settings.json where Cline resolves it", () => {
  // cline 3.0.65, sdk/packages/shared/src/storage/paths.ts, `resolveMcpSettingsPath`.
  const at = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux", home = "/home/dev") =>
    clineMcpSettings({ env, home, platform, cwd: platform === "win32" ? "C:\\work" : "/work" });
  expect(at({})).toBe("/home/dev/.cline/data/settings/cline_mcp_settings.json");
  expect(at({ CLINE_DIR: "/c" })).toBe("/c/data/settings/cline_mcp_settings.json");
  expect(at({ CLINE_DIR: "/c", CLINE_DATA_DIR: "/d" })).toBe("/d/settings/cline_mcp_settings.json");
  expect(at({ CLINE_DATA_DIR: " ", CLINE_DIR: " " })).toBe("/home/dev/.cline/data/settings/cline_mcp_settings.json");
  expect(at({ CLINE_MCP_SETTINGS_PATH: "/m/mcp.json", CLINE_DATA_DIR: "/d" })).toBe("/m/mcp.json");
  expect(at({ CLINE_MCP_SETTINGS_PATH: "cfg/mcp.json" })).toBe("/work/cfg/mcp.json");
  expect(at({}, "win32", "C:\\Users\\dev")).toBe("C:\\Users\\dev\\.cline\\data\\settings\\cline_mcp_settings.json");
});

it("connects over the ACP bridge with Cline's confirmed --acp command, plus Cline's own MCP settings file", () => {
  expect(agent.connect).toEqual({ kind: "acp-bridge", mcpSettings: clineMcpSettings });
  // `cline --acp` is Cline's own documented ACP launch (docs.cline.bot/usage/acp).
  expect(agent.start).toEqual({
    kind: "acp-bridge",
    command: "cline",
    args: ["--acp"],
    prompt: "Answer Relay messages with Cline from this folder?",
    noCommands: { args: ["--auto-approve", "false"] },
  });
});

it("connect starts Cline over its ACP bridge", async () => {
  const scratch = join(tmpdir(), "relay-target-start-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const token = `rel_token_${"C".repeat(43)}`;
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
    success: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    message: vi.fn((message: string) => { stdout.push(`${message}\n`); }),
    note: vi.fn((message: string, title: string) => { stdout.push(`${title}\n${message}\n`); }),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn((message: string) => { stdout.push(`${message}\n`); }) })),
  };
  expect(await runCLI(["connect", "cline", "--token", token, "--yes", "--no-skill"], {
    configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, home, platform: process.platform },
    cwd: home, isInteractive: true, prompts,
    fetch: vi.fn(async () => Response.json({ contact_cards: [{ handle: "calm_cangoo", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] })),
    stdout: (value) => stdout.push(value), stderr: () => undefined,
    connect: {
      sniff: async () => [{ id: "cline", label: "Cline", found: true }],
      bridge, observer: () => ({ semantics: "observational-no-ack", run: async () => undefined }),
      renderQR: () => "[QR]\n", version: "0.1.6-staging.0",
    },
  })).toBe(0);
  expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ command: "cline", acpArgs: ["--acp"], kind: "acp" }));
});
