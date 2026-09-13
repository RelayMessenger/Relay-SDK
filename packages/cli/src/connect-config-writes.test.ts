import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "./config.js";
import { runCLI } from "./program.js";
import { inspectWindowsAcl, protectWindowsPath } from "./runtime-connect/windows-acl.js";

// Windows CI (windows-2025, 2026-09-12) refused connect for Codex and OpenCode:
// "Other people on this computer can read the Relay config file." The check in
// private-file.ts refuses an EXISTING file with group or other mode bits when
// the platform is not win32, and a Windows host reports 0o666 on every file.
// The first config write finds no file and passes; a second write in the same
// connect finds the file and refuses. So connect writes the config once, and
// this test counts the writes with the Windows branch forced, the way
// config-windows.test.ts does: every private write protects one temp file.
vi.mock("./runtime-connect/windows-acl.js", async (original) => ({
  ...await original<typeof import("./runtime-connect/windows-acl.js")>(),
  inspectWindowsAcl: vi.fn(), protectWindowsPath: vi.fn(),
}));
const acl = () => ({ owner: "current", user: "current", sddl: "private", rules: [{ sid: "current", rights: 2032127, type: "Allow" }] });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(inspectWindowsAcl).mockResolvedValue(acl());
  vi.mocked(protectWindowsPath).mockResolvedValue(acl());
});

const token = `rel_token_${"C".repeat(43)}`;
const card = { handle: "calm_cangoo.dev", first_name: "Calm Canada Goose", last_name: null, image_url: null, kind: "agent", is_active: true };

async function connect(agent: "codex" | "opencode", args: string[], executable: string | undefined) {
  const scratch = join(tmpdir(), "relay-config-writes-test");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "connect-"));
  const stderr: string[] = [];
  const configContext = { env: { RELAY_CONFIG_PATH: join(home, "config.json"), PATH: "" }, home, platform: "win32" as const };
  const code = await runCLI(["connect", agent, ...args, "--yes", "--no-skill", "--json"], {
    configContext, cwd: home, isInteractive: false,
    stdout: () => undefined, stderr: (value) => stderr.push(value),
    fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ agent: card, secret: token, share_url: `https://relayapp.im/@${card.handle}` }, { status: 201 })
      : Response.json({ contact_cards: [card] })),
    connect: {
      sniff: async () => [{ id: agent, label: agent, found: true, ...(executable ? { executable } : {}) }],
      runCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      version: "0.1.6-staging.0",
    },
  });
  return { code, stderr, configContext };
}

describe("connect writes the config once, with the Windows branch forced", () => {
  it.each([
    ["codex", ["--new"], "/detected/bin/codex"],
    ["codex", ["--new"], undefined],
    ["opencode", ["--token", token], "/detected/bin/opencode"],
    ["opencode", ["--token", token], undefined],
  ] as const)("%s %j executable=%s", async (agent, args, executable) => {
    const { code, stderr, configContext } = await connect(agent, [...args], executable);
    expect(code, stderr.join("")).toBe(0);
    expect(stderr.join("")).toBe("");
    // One completed private write of the config: the final ACL is inspected once
    // (config-windows.test.ts, "protects the empty temp before any secret bytes and
    // inspects final ACL"). A created agent's preflight protects a temp too, so the
    // temp count is not the write count; the final inspection is.
    expect(vi.mocked(inspectWindowsAcl).mock.calls.filter(([path]) => path === configContext.env.RELAY_CONFIG_PATH)).toHaveLength(1);
    const saved = await readConfig(configContext);
    expect(saved.defaultAgent).toBe(card.handle);
    expect(saved.profiles[card.handle]?.agent_token).toBe(token);
  });
});
