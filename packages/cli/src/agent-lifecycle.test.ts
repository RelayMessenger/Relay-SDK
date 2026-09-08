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
  const deps = { configContext: { env }, fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin === "https://api.staging.relayapp.im" || url.hostname.endsWith(".staging.test")).toBe(true);
    return fetch(input, init);
  }, stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s) };
  return { deps, env, fetch, output, home };
}

describe("agent CLI persisted workflows", { timeout: 120_000 }, () => {
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
    config.profiles.laptop = { api_url: "https://one.staging.test", agent_token: "first-token" };
    config.profiles.other = { api_url: "https://two.staging.test", agent_token: "second-token" };
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
    config.profiles.one = { api_url: "https://one.staging.test", agent_token: "one-token" };
    config.profiles.two = { api_url: "https://two.staging.test", agent_token: "two-token" };
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
    env.RELAY_API_URL = "https://api.staging.relayapp.im";
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
    env.RELAY_API_URL = "https://unrelated.staging.test";
    expect(await runCLI(["--profile", handle, "auth", "login", "--connect", "hermes", "--runtime-home", home, "--runtime-state-dir", join(home, "state"), ...confirmations], deps)).toBe(0);
    expect((await readConfig(deps.configContext)).profiles[handle]?.api_url).toBe("https://api.staging.relayapp.im");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("existing-token login handoff binds an explicit new OpenClaw account without any POST", async () => {
    const { deps, env, home, fetch, output } = await fixture();
    env.RELAY_AGENT_TOKEN = "existing-env-token";
    const path = join(home, "openclaw.json");
    await writeFile(path, JSON.stringify({ channels: { relay: { allowFrom: ["alice"], accounts: { other: { token: "other-credential", allowFrom: ["bob"] } } } } }), { mode: 0o600 });
    expect(await runCLI(["auth", "login", "--api-url", "https://api.staging.relayapp.im", "--connect", "openclaw", "--runtime-config", path, "--runtime-state-dir", home, "--runtime-account", "new-account", ...confirmations], deps)).toBe(0);
    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.channels.relay.accounts["new-account"].token).toBe("existing-env-token");
    expect(config.channels.relay.accounts.other).toEqual({ token: "other-credential", allowFrom: ["bob"] });
    expect(config.channels.relay.allowFrom).toEqual(["alice"]);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(JSON.parse(output[0]!).handoff).toMatchObject({ status: "configured", connected: false });
    expect(output.join("")).not.toMatch(/existing-env-token|other-credential/);
  });
  it("validates confirmations before creating and never falls back on invalid login handoff auth", async () => {
    const { deps, env, home, fetch } = await fixture();
    expect(await runCLI(["agents", "create", "--connect", "hermes", "--runtime-home", home], deps)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    await writeFile(join(home, "config.yaml"), 'gateway: {}\n', { mode: 0o600 });
    env.RELAY_AGENT_TOKEN = "invalid-env-token";
    env.RELAY_API_URL = "https://api.staging.relayapp.im";
    fetch.mockImplementation(async () => Response.json({ error: { message: "invalid-env-token" } }, { status: 401 }));
    expect(await runCLI(["auth", "login", "--api-url", "https://api.staging.relayapp.im", "--connect", "hermes", "--runtime-home", home, "--runtime-state-dir", home, ...confirmations], deps)).toBe(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await expect(readFile(join(home, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("does not delete on another origin if a profile changes during automatic identification", async () => {
  const { deps, fetch } = await fixture();
  const config = emptyConfig();
  config.profiles.one = { api_url: "https://one.staging.test", agent_token: "one-token" };
  await writeConfig(config, deps.configContext);
  fetch.mockImplementation(async (_url, init) => {
    expect(init?.method).toBe("GET");
    const changed = await readConfig(deps.configContext);
    changed.profiles.one = { api_url: "https://two.staging.test", agent_token: "two-token" };
    await writeConfig(changed, deps.configContext);
    return Response.json({ contact_cards: [card] });
  });
  expect(await runCLI(["agents", "delete", handle], deps)).toBe(1);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  expect((await readConfig(deps.configContext)).profiles.one?.agent_token).toBe("two-token");
});

it("new staging creation ignores a tokenless legacy production default without rewriting it", async () => {
  const { deps, fetch } = await fixture();
  const legacy = emptyConfig();
  await writeConfig(legacy, deps.configContext);
  expect(await runCLI(["agents", "create", "--json"], deps)).toBe(0);
  expect(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![0])).toBe("https://api.staging.relayapp.im/v1/agents");
  const after = await readConfig(deps.configContext);
  expect(after.profiles.default).toEqual(legacy.profiles.default);
  expect(after.profiles[handle]?.api_url).toBe("https://api.staging.relayapp.im");
});

it("keeps exactly the three approved agents verbs and a version-aware creation origin", async () => {
  const { createProgram } = await import("./program.js");
  const { defaultCreationApiURL } = await import("./config.js");
  const { deps } = await fixture();
  const program = createProgram(deps);
  expect(program.name()).toBe("relaymessenger");
  expect(program.commands.find((command) => command.name() === "agents")!.commands.map((command) => command.name())).toEqual(["create", "list", "delete"]);
  expect(defaultCreationApiURL("0.1.0-staging.0")).toBe("https://api.staging.relayapp.im");
  expect(defaultCreationApiURL("0.1.0")).toBe("https://api.relayapp.im");
});

it("auth login validates through the agent API and retains healthy credentials on rejection", async () => {
  const { deps, env, fetch } = await fixture();
  const config = emptyConfig();
  config.profiles.saved = { api_url: "https://api.staging.relayapp.im", agent_token: "healthy-existing-token" };
  await writeConfig(config, deps.configContext);
  env.RELAY_AGENT_TOKEN = "invalid-supplied-token";
  fetch.mockImplementation(async () => Response.json({ error: { message: "invalid-supplied-token" } }, { status: 401 }));
  expect(await runCLI(["--profile", "saved", "auth", "login", "--api-url", "https://api.staging.relayapp.im"], deps)).toBe(1);
  expect(await readConfig(deps.configContext)).toEqual(config);
  expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

it("exposes canonical auth login/status/logout without a token-import command", async () => {
  const { createProgram } = await import("./program.js");
  const { deps } = await fixture();
  const program = createProgram(deps);
  expect(program.commands.some((command) => command.name() === "token")).toBe(false);
  expect(program.commands.find((command) => command.name() === "auth")!.commands.map((command) => command.name())).toEqual(["login", "status", "logout"]);
});

it("non-TTY login without a token fails without reading stdin, fetching, or changing config", async () => {
  const { deps, fetch, output } = await fixture();
  const readStdin = vi.fn(async () => "must-not-read");
  const readSecret = vi.fn(async () => "must-not-prompt");
  expect(await runCLI(["auth", "login", "--api-url", "https://api.staging.relayapp.im"], { ...deps, isInteractive: false, readStdin, readSecret })).toBe(1);
  expect(fetch).not.toHaveBeenCalled(); expect(readStdin).not.toHaveBeenCalled(); expect(readSecret).not.toHaveBeenCalled();
  expect(output.join("")).toContain("--with-token");
  expect(await readConfig(deps.configContext)).toEqual(emptyConfig());
});

it("plain interactive login reads a private prompt; --with-token selects stdin over ENV", async () => {
  const { deps, env, output } = await fixture();
  const readSecret = vi.fn(async () => "prompt-private-token");
  expect(await runCLI(["auth", "login", "--api-url", "https://api.staging.relayapp.im"], { ...deps, isInteractive: true, readSecret })).toBe(0);
  expect(readSecret).toHaveBeenCalledOnce();
  expect((await readConfig(deps.configContext)).profiles.default?.agent_token).toBe("prompt-private-token");
  env.RELAY_AGENT_TOKEN = "other-env-token";
  expect(await runCLI(["auth", "login", "--with-token", "--api-url", "https://api.staging.relayapp.im"], { ...deps, isInteractive: false, readStdin: async () => "stdin-private-token\n" })).toBe(0);
  expect((await readConfig(deps.configContext)).profiles.default?.agent_token).toBe("stdin-private-token");
  expect(output.join("")).not.toMatch(/prompt-private-token|stdin-private-token|other-env-token/);
});

});
