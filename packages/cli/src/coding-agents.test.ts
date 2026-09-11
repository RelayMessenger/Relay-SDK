import { execFileSync } from "node:child_process";
import { posix, win32 } from "node:path";
import { expect, it } from "vitest";
import { CODING_AGENTS, CODING_AGENT_IDS, agentDetectedAs, codingAgent, normalizeAgentId, supportedAgentsLine } from "./coding-agents.js";
import { agentFiles, agentPlan, runtimeConnectPlan, type PlanContext } from "./connect.js";
import { createProgram } from "./program.js";

/** The ten, in the order the page's section 4 lists them. Ruled 2026-09-10. */
const TEN = ["claude-code", "codex", "cursor", "opencode", "cline", "vscode", "gemini-cli", "claude-desktop", "hermes", "openclaw"] as const;

const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  env: {}, home: "/home/dev", platform: "linux", version: "0.1.6-staging.3",
  profile: "calm_cangoo.dev", handle: "calm_cangoo.dev", allow: [], start: false, ...overrides,
});

it("the registry is exactly the ten ruled agents, in the help's order", () => {
  expect(CODING_AGENT_IDS).toEqual(TEN);
  expect(new Set(CODING_AGENTS.map((agent) => agent.label)).size).toBe(TEN.length);
});

it("the help's Supported agents line is built from the registry", () => {
  expect(supportedAgentsLine()).toBe(`Supported agents: ${TEN.join(" ")}`);
  const connect = createProgram({ configContext: { env: {}, home: "/home/dev" } }).commands.find((command) => command.name() === "connect")!;
  const help = connect.helpInformation();
  expect(help.startsWith(`Usage: relaymessenger connect [options] [agent]\n${supportedAgentsLine()}\n`)).toBe(true);
  expect(help).toMatch(/^  agent +Coding agent to connect \(see Supported agents above\)$/mu);
  expect(help).toMatch(/^  --all +connect every detected coding agent$/mu);
  expect(help).toMatch(/^  -y, --yes +take the plan as it is$/mu);
  // Gone: the old argument line and the old runtime words.
  expect(help).not.toContain("what will answer as this agent");
  expect(help).not.toContain("runtime");
});

it("claude stays as an alias of claude-code; ids and aliases resolve, nonsense does not", () => {
  expect(normalizeAgentId("claude")).toBe("claude-code");
  expect(normalizeAgentId(" Claude-Code ")).toBe("claude-code");
  for (const id of TEN) expect(normalizeAgentId(id)).toBe(id);
  expect(normalizeAgentId("gemini")).toBe("gemini-cli");
  expect(normalizeAgentId("nonsense")).toBeUndefined();
  expect(normalizeAgentId("other")).toBeUndefined();
});

it("@vercel/detect-agent's names map onto ours, and unknown names onto nothing", () => {
  expect(agentDetectedAs("claude")).toBe("claude-code");
  expect(agentDetectedAs("cursor-cli")).toBe("cursor");
  expect(agentDetectedAs("gemini")).toBe("gemini-cli");
  expect(agentDetectedAs("codex")).toBe("codex");
  expect(agentDetectedAs("opencode")).toBe("opencode");
  // AI_AGENT names: the package's own convention and Claude Code 2.1's.
  expect(agentDetectedAs("claude-code")).toBe("claude-code");
  expect(agentDetectedAs("claude-code_2-1-261_agent")).toBe("claude-code");
  expect(agentDetectedAs("cursor-cli@1")).toBe("cursor");
  expect(agentDetectedAs("devin")).toBeUndefined();
  expect(agentDetectedAs("relay")).toBeUndefined();
});

it("every agent has a plan that names the real file it writes", () => {
  const home = "/home/dev";
  const expected: Record<(typeof TEN)[number], string> = {
    "claude-code": posix.join(home, ".claude", "channels", "relay", ".env"),
    codex: posix.join(home, ".codex", "config.toml"),
    cursor: posix.join(home, ".cursor", "mcp.json"),
    opencode: posix.join(home, ".config", "opencode", "opencode.json"),
    cline: posix.join(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    vscode: posix.join(home, ".config", "Code", "User", "mcp.json"),
    "gemini-cli": posix.join(home, ".gemini", "settings.json"),
    "claude-desktop": posix.join(home, ".config", "claude", "claude_desktop_config.json"),
    hermes: posix.join(home, ".hermes", ".env"),
    openclaw: posix.join(home, ".openclaw", "secrets", "relay-calm_cangoo.dev.token"),
  };
  for (const id of TEN) {
    const plan = agentPlan(id, context());
    expect(plan.files[0], id).toBe(expected[id]);
    expect(plan.steps.length, id).toBeGreaterThan(0);
    expect(plan.steps.join("\n"), id).toContain(expected[id]);
  }
  expect(agentFiles("openclaw", context())[1]).toBe(posix.join(home, ".openclaw", "openclaw.json"));
});

it("macOS and Windows put VS Code and Claude Desktop where their vendors say", () => {
  const mac = context({ platform: "darwin" });
  expect(agentFiles("vscode", mac)[0]).toBe("/home/dev/Library/Application Support/Code/User/mcp.json");
  expect(agentFiles("claude-desktop", mac)[0]).toBe("/home/dev/Library/Application Support/Claude/claude_desktop_config.json");
  const windows = context({ platform: "win32", home: "C:\\Users\\dev", env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" } });
  expect(agentFiles("vscode", windows)[0]).toBe(win32.join("C:\\Users\\dev\\AppData\\Roaming", "Code", "User", "mcp.json"));
  expect(agentFiles("claude-desktop", windows)[0]).toBe(win32.join("C:\\Users\\dev\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
});

it("the MCP agents run our server by npx, the staging tag on a staging build", () => {
  const staging = agentPlan("codex", context());
  expect(staging.commands).toEqual(["codex mcp add relay -- npx -y @relaymessenger/mcp@staging --profile calm_cangoo.dev"]);
  const release = agentPlan("gemini-cli", context({ version: "0.2.0" }));
  expect(release.commands).toEqual(["gemini mcp add -s user relay npx -- -y @relaymessenger/mcp --profile calm_cangoo.dev"]);
  const cline = agentPlan("cline", context());
  expect(cline.commands).toEqual(["cline mcp add --yes relay -- npx -y @relaymessenger/mcp@staging --profile calm_cangoo.dev"]);
  // A config file that is not the default one travels with the server.
  const elsewhere = agentPlan("codex", context({ env: { RELAY_CONFIG_PATH: "/tmp/x/config.json" } }));
  expect(elsewhere.commands[0]).toContain("--env RELAY_CONFIG_PATH=/tmp/x/config.json");
});

it("the composed plan counts every step of every chosen agent", () => {
  const plan = runtimeConnectPlan({ ...context({ start: true }), agents: ["claude-code", "cursor", "hermes"], agentStep: "create a new agent" });
  expect(plan.headline).toBe(`Relay will do ${plan.steps.length} things. Continue?`);
  expect(plan.steps[0]).toBe("  1  create a new agent");
  expect(plan.agents.map((entry) => entry.agent)).toEqual(["claude-code", "cursor", "hermes"]);
  expect(plan.steps.length).toBe(1 + 4 + 1 + 3);
  expect(codingAgent("cursor").label).toBe("Cursor");
  expect(runtimeConnectPlan({ ...context(), agents: ["cursor"] }).headline).toBe("Relay will do 1 thing. Continue?");
});


it("every agent plan uses Windows separators independently of the host", () => {
  const windows = context({ platform: "win32", home: "C:\\Users\\dev" });
  const expected = [
    ".claude/channels/relay/.env", ".codex/config.toml", ".cursor/mcp.json",
    ".config/opencode/opencode.json", ".cline/data/settings/cline_mcp_settings.json",
    "AppData/Roaming/Code/User/mcp.json", ".gemini/settings.json",
    "AppData/Roaming/Claude/claude_desktop_config.json", ".hermes/.env",
    ".openclaw/secrets/relay-calm_cangoo.dev.token",
  ];
  TEN.forEach((id, index) => {
    expect(agentFiles(id, windows)[0], id).toBe(win32.join(windows.home, expected[index]!));
  });
  expect(agentPlan("codex", windows).commands).toEqual(["codex mcp add relay -- npx -y @relaymessenger/mcp@staging --profile calm_cangoo.dev"]);
});

it("the split registry preserves every definition and function source", async () => {
  // Native type stripping preserves function source text; Vitest's bundler does not.
  const serialized = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      return nextResolve(specifier.startsWith(".") && specifier.endsWith(".js")
        ? specifier.slice(0, -3) + ".ts" : specifier, context);
    } });
    const { CODING_AGENTS } = await import(${JSON.stringify(new URL("./coding-agents.ts", import.meta.url).href)});
    process.stdout.write(JSON.stringify(CODING_AGENTS, (_key, value) => typeof value === "function" ? value.toString() : value, 2) + "\\n");
  `], { encoding: "utf8" });
  await expect(serialized).toMatchFileSnapshot("./coding-agents/__snapshots__/registry.json");
});
