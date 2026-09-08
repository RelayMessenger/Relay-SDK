import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { protectWindowsPath } from "./runtime-connect/windows-acl.js";
import { runCLI } from "./program.js";
import { emptyConfig, readConfig, writeConfig } from "./config.js";

const handle = "brave_cangoo.dev";
const card = { handle, first_name: "Brave Canada Goose", last_name: null, image_url: null, is_active: true, kind: "agent" };
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relay agent lifecycle-")));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  const env: NodeJS.ProcessEnv = { RELAY_CONFIG_PATH: join(home, "config.json") };
  const output: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ agent: card, secret: "created-private-token", share_url: `https://go.test/@${handle}` }, { status: 201 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ contact_cards: [card] });
  });
  const deps = { configContext: { env }, fetch, stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s) };
  return { deps, env, fetch, output, home };
}

describe("real persisted agent selection", { timeout: 120_000 }, () => {
  it("plain create then delete returned handle works from fresh config", async () => {
    const { deps, fetch, output } = await fixture();
    expect(await runCLI(["agents", "list", "--json"], deps)).toBe(0);
    expect(JSON.parse(output.pop()!).agents).toEqual([]);
    expect(await runCLI(["agents", "create", "--json"], deps)).toBe(0);
    expect(await runCLI(["agents", "list", "--json"], deps)).toBe(0);
    expect(JSON.parse(output.pop()!).agents).toHaveLength(1);
    expect((await readConfig(deps.configContext)).current_profile).toBe("default");
    expect(await runCLI(["agents", "delete", handle], deps)).toBe(0);
    const config = await readConfig(deps.configContext);
    expect(config.profiles[handle]?.agent_token).toBeUndefined();
    expect(config.profiles.default).toEqual(emptyConfig().profiles.default);
    expect(await runCLI(["agents", "list", "--json"], deps)).toBe(0);
    expect(JSON.parse(output.pop()!).agents).toEqual([]);
    const deletion = fetch.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(new Headers(deletion[1]?.headers).get("authorization")).toBe("Bearer created-private-token");
    expect(output.join("")).not.toContain("created-private-token");
  });
  it("matches actual Contact Cards rather than profile names and preserves others", async () => {
    const { deps, fetch } = await fixture();
    const config = emptyConfig();
    config.profiles.laptop = { api_url: "https://one.test", agent_token: "first-token" };
    config.profiles.other = { api_url: "https://two.test", agent_token: "second-token" };
    await writeConfig(config, deps.configContext);
    fetch.mockImplementation(async (_url, init) => init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ contact_cards: [{ ...card, handle: new Headers(init?.headers).get("authorization") === "Bearer first-token" ? handle : "other.dev" }] }));
    expect(await runCLI(["agents", "delete", handle], deps)).toBe(0);
    const saved = await readConfig(deps.configContext);
    expect(saved.profiles.laptop?.agent_token).toBeUndefined();
    expect(saved.profiles.other?.agent_token).toBe("second-token");
  });
  it("refuses cross-origin matches without deletion; explicit selection resolves it", async () => {
    const { deps, fetch } = await fixture();
    const config = emptyConfig();
    config.profiles.one = { api_url: "https://one.test", agent_token: "one-token" };
    config.profiles.two = { api_url: "https://two.test", agent_token: "two-token" };
    await writeConfig(config, deps.configContext);
    expect(await runCLI(["agents", "delete", handle], deps)).toBe(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect(await readConfig(deps.configContext)).toEqual(config);
    expect(await runCLI(["--profile", "one", "agents", "delete", handle], deps)).toBe(0);
    expect((await readConfig(deps.configContext)).profiles.two?.agent_token).toBe("two-token");
  });
  it("never falls back after explicit invalid ENV auth", async () => {
    const { deps, env, fetch } = await fixture();
    expect(await runCLI(["agents", "create", "--json"], deps)).toBe(0);
    env.RELAY_AGENT_TOKEN = "invalid-env-token";
    fetch.mockImplementation(async () => Response.json({ error: { message: "invalid" } }, { status: 401 }));
    expect(await runCLI(["agents", "delete", handle], deps)).toBe(1);
    expect((await readConfig(deps.configContext)).profiles[handle]?.agent_token).toBe("created-private-token");
  });
});

describe("real program runtime handoff", { timeout: 120_000 }, () => {
  const confirmations = ["--confirm-configure", "--runtime-stopped"];
  it("create -> Hermes binds the newly saved credential, not unrelated ENV auth", async () => {
    const { deps, env, home, output, fetch } = await fixture();
    env.RELAY_AGENT_TOKEN = "unrelated-env-secret";
    const yaml = 'gateway:\n  platforms:\n    relayapp:\n      enabled: true\n      extra:\n        allowed_contacts: [alice]\n';
    await writeFile(join(home, "config.yaml"), yaml, { mode: 0o600 });
    expect(await runCLI(["agents", "create", "--json", "--connect", "hermes", "--runtime-home", home, "--runtime-state-dir", join(home, "state"), ...confirmations], deps)).toBe(0);
    const saved = await readFile(join(home, ".env"), "utf8");
    expect(saved).toContain('RELAY_AGENT_TOKEN="created-private-token"');
    expect(saved).not.toContain("unrelated-env-secret");
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(yaml);
    const result = JSON.parse(output[0]!);
    expect(result.handoff).toMatchObject({ status: "configured", connected: false, handle });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(output.join("")).not.toContain("created-private-token");
    expect(output.join("")).not.toContain("unrelated-env-secret");
  });
  it("existing-token setup binds an explicit new OpenClaw account without any POST", async () => {
    const { deps, env, home, fetch, output } = await fixture();
    env.RELAY_AGENT_TOKEN = "existing-env-token";
    const path = join(home, "openclaw.json");
    await writeFile(path, JSON.stringify({ channels: { relay: { allowFrom: ["alice"], accounts: { other: { token: "other-credential", allowFrom: ["bob"] } } } } }), { mode: 0o600 });
    expect(await runCLI(["agents", "setup", "--json", "--connect", "openclaw", "--runtime-config", path, "--runtime-state-dir", home, "--runtime-account", "new-account", ...confirmations], deps)).toBe(0);
    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.channels.relay.accounts["new-account"].token).toBe("existing-env-token");
    expect(config.channels.relay.accounts.other).toEqual({ token: "other-credential", allowFrom: ["bob"] });
    expect(config.channels.relay.allowFrom).toEqual(["alice"]);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(JSON.parse(output[0]!).handoff).toMatchObject({ status: "configured", connected: false });
    expect(output.join("")).not.toMatch(/existing-env-token|other-credential/);
  });
  it("validates confirmations before creating and never falls back on invalid setup auth", async () => {
    const { deps, env, home, fetch } = await fixture();
    expect(await runCLI(["agents", "create", "--connect", "hermes", "--runtime-home", home], deps)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    await writeFile(join(home, "config.yaml"), 'gateway: {}\n', { mode: 0o600 });
    env.RELAY_AGENT_TOKEN = "invalid-env-token";
    fetch.mockImplementation(async () => Response.json({ error: { message: "invalid-env-token" } }, { status: 401 }));
    expect(await runCLI(["agents", "setup", "--connect", "hermes", "--runtime-home", home, "--runtime-state-dir", home, ...confirmations], deps)).toBe(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await expect(readFile(join(home, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
