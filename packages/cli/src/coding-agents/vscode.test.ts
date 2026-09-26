import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractivePrompts } from "../interactive.js";
import { runCLI } from "../program.js";
import type { TerminalObserver } from "../terminal-watch.js";
import agent from "./vscode.js";

/** The file connect writes for VS Code, for one platform and environment. */
const mcpFile = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string => {
  if (agent.connect.kind !== "mcp-file") throw new Error("VS Code connects through its mcp.json");
  return agent.connect.file({ env, home, platform, cwd: home });
};

it("writes mcp.json in the user-data folder VS Code itself resolves", () => {
  // VS Code 1.139.1, out/main.js (the user-data path function, saved at
  // _sources/vscode-connect-test-20260926/vscode-1.139.1-main.js-userDataPath.txt).
  expect(mcpFile("linux", { XDG_CONFIG_HOME: "/home/dev/xdg" }, "/home/dev")).toBe(posix.join("/home/dev/xdg", "Code", "User", "mcp.json"));
  expect(mcpFile("linux", {}, "/home/dev")).toBe("/home/dev/.config/Code/User/mcp.json");
  expect(mcpFile("linux", { XDG_CONFIG_HOME: "" }, "/home/dev")).toBe("/home/dev/.config/Code/User/mcp.json");
  expect(mcpFile("darwin", { XDG_CONFIG_HOME: "/Users/dev/xdg" }, "/Users/dev")).toBe("/Users/dev/Library/Application Support/Code/User/mcp.json");
  expect(mcpFile("win32", { APPDATA: "D:\\Roaming", XDG_CONFIG_HOME: "C:\\xdg" }, "C:\\Users\\dev")).toBe(win32.join("D:\\Roaming", "Code", "User", "mcp.json"));
  expect(mcpFile("win32", { USERPROFILE: "C:\\Users\\dev" }, "C:\\Users\\other")).toBe(win32.join("C:\\Users\\dev", "AppData", "Roaming", "Code", "User", "mcp.json"));
  expect(mcpFile("linux", { VSCODE_APPDATA: "/data", XDG_CONFIG_HOME: "/home/dev/xdg" }, "/home/dev")).toBe("/data/Code/User/mcp.json");
  expect(mcpFile("linux", { VSCODE_PORTABLE: "/opt/vscode/data", VSCODE_APPDATA: "/data" }, "/home/dev")).toBe("/opt/vscode/data/user-data/User/mcp.json");
  expect(agent.installedIf({ env: { XDG_CONFIG_HOME: "/home/dev/xdg" }, home: "/home/dev", platform: "linux", cwd: "/home/dev" })).toContain("/home/dev/xdg/Code");
});

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
  const token = `rel_token_${"C".repeat(43)}`;
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
      fetch: async () => Response.json({ contact_cards: [{ handle: "calm_cangoo", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true }] }),
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
    expect(stdout.join("")).toContain("No reply yet. Run:  relay watch @calm_cangoo");
  } finally {
    vi.useRealTimers();
  }
});
