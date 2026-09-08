import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "./program.js";
import { emptyConfig, readConfig, writeConfig } from "./config.js";
import { openSavedAgentSession, savedAgentShareURL } from "./agent-session.js";
import type { TerminalSessionOptions } from "./terminal-session.js";

const base = "https://api.staging.relayapp.im";
const token = `rly_live_${"V".repeat(43)}`;
const card = { handle: "view_agent.dev", first_name: "View Agent", last_name: null, image_url: `${base}/assets/relay.png`, is_active: true, kind: "agent" as const };
const exited = { reason: "quit" as const, observedEvents: 0, observerStopped: true };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "relay-persistent-view-"));
  const configContext = { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_API_URL: base } as NodeJS.ProcessEnv };
  const output: string[] = [];
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); expect(url.origin).toBe(base);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "POST" && url.pathname === "/v1/agents") return Response.json({ agent: card, secret: token, share_url: `https://staging.relayapp.im/@${card.handle}` }, { status: 201 });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    return Response.json({ contact_cards: [card] });
  };
  const terminalSession = vi.fn(async (_options: TerminalSessionOptions) => exited);
  const deps = { configContext, fetch, terminalSession, isInteractive: true, skillPresent: async () => true,
    stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s),
  };
  return { home, configContext, deps, terminalSession, output, calls };
}
describe("persistent session command wiring", { timeout: 120_000 }, () => {
  it("waits in the post-create session using the actual saved identity, never unrelated ENV", async () => {
    const f = await fixture(); f.configContext.env.RELAY_AGENT_TOKEN = "unrelated-env-token";
    let close: (() => void) | undefined;
    f.terminalSession.mockImplementation(async (options) => {
      expect((await readConfig(f.configContext)).profiles[card.handle]?.agent_token).toBe(token);
      expect(options.agent).toEqual({ handle: card.handle, name: card.first_name, profile: card.handle, shareUrl: `https://staging.relayapp.im/@${card.handle}` });
      expect(options.runtime).toEqual({ ownership: "none", connection: "not-started" });
      expect(options.observer?.semantics).toBe("observational-no-ack");
      expect(options.secrets).toEqual([token]);
      await new Promise<void>((resolve) => { close = resolve; });
      return exited;
    });
    let finished = false;
    const pending = runCLI(["agents", "create"], f.deps).then((code) => { finished = true; return code; });
    await vi.waitFor(() => expect(close).toBeDefined()); expect(finished).toBe(false);
    close!(); expect(await pending).toBe(0);
    expect(f.calls.filter((call) => call === "POST /v1/agents")).toHaveLength(1);
    expect(f.output.join("")).not.toMatch(/unrelated-env-token|rly_live_[A-Za-z0-9]{43}/u);
  });
  it.each([["--json"], ["--non-interactive"], []])("never opens a persistent session for scripted/JSON or nonTTY create %j", async (...flags) => {
    const f = await fixture();
    const args = flags as string[];
    expect(await runCLI([...args, "agents", "create"], { ...f.deps, isInteractive: args.length > 0 })).toBe(0);
    expect(f.terminalSession).not.toHaveBeenCalled();
  });
  it("reopens a saved identity through interactive auth status without bootstrapping", async () => {
    const f = await fixture(); const config = emptyConfig(); config.profiles.saved = { api_url: base, agent_token: token };
    await writeConfig(config, f.configContext);
    expect(await runCLI(["--profile", "saved", "auth", "status"], f.deps)).toBe(0);
    expect(f.terminalSession).toHaveBeenCalledOnce();
    const options = f.terminalSession.mock.calls[0]![0]; expect(options.runtime).toEqual({ ownership: "unknown", connection: "unknown" });
    expect(options.agent.shareUrl).toBe(`https://staging.relayapp.im/@${card.handle}`);
    expect(f.calls.some((call) => call.startsWith("POST"))).toBe(false);
    expect((await readConfig(f.configContext)).profiles.saved?.agent_token).toBe(token);
  });
  it("does not silently show a different saved identity for ENV auth status", async () => {
    const f = await fixture(); const config = emptyConfig(); config.profiles.saved = { api_url: base, agent_token: token };
    await writeConfig(config, f.configContext); f.configContext.env.RELAY_AGENT_TOKEN = "different-env-token";
    expect(await runCLI(["--profile", "saved", "auth", "status"], f.deps)).toBe(0);
    expect(f.terminalSession).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it("retains created credentials if only terminal presentation fails", async () => {
    const f = await fixture(); f.terminalSession.mockRejectedValueOnce(new Error(token));
    expect(await runCLI(["agents", "create"], f.deps)).toBe(0);
    expect((await readConfig(f.configContext)).profiles[card.handle]?.agent_token).toBe(token);
    expect(f.output.join("")).not.toContain(token); expect(f.output.join("")).toContain("saved agent and token remain unchanged");
  });
});

it("saved-session observer uses SDK observe:true even for unknown/external ownership", async () => {
  const f = await fixture(); const config = emptyConfig(); config.profiles.saved = { api_url: base, agent_token: token };
  const websocket = vi.fn(async (_options: any) => undefined);
  await openSavedAgentSession({ profile: "saved", runtime: { ownership: "external", connection: "unknown" } }, {
    agents: { read: async () => config },
    client: (secret, origin) => { expect(secret).toBe(token); expect(origin).toBe(base); return { contactCard: { retrieve: async () => ({ contact_cards: [card] }) } as any, websocket: { run: websocket } }; },
    session: async (options) => {
      await options.observer!.run({ signal: new AbortController().signal, onStatus() {}, onEvent() {} }); return exited;
    },
  });
  expect(websocket.mock.calls[0]![0].observe).toBe(true);
  expect(savedAgentShareURL("https://unknown.example.test", card.handle)).toBe("");
});
