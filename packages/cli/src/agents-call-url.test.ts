import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { emptyConfig, writeConfig } from "./config.js";
import { runCLI } from "./program.js";

const setup = async () => {
  const context = { env: { RELAY_CONFIG_PATH: join(await mkdtemp(join(tmpdir(), "relay-call-url-")), "config.json") } };
  const config = emptyConfig();
  config.console = { access_token: "session-secret", expires_at: Date.now() + 60_000, organization_id: "org", user: { id: "user", email: "test@example.com" } };
  config.profiles.default = { agent_token: "rly_test_secret", api_url: "https://api.staging.relayapp.im" };
  await writeConfig(config, context);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") return Response.json({ agent: { id: "agent-id" }, handle: "coda", first_name: "Coda", image_url: null });
    if (url.endsWith("/me")) return Response.json({ org: { id: "org" } });
    if (init?.method === "POST") return Response.json({ agent: { id: "agent-id", handle: "coda", displayName: "Coda", avatarUrl: null }, token: "rly_created_secret" });
    if (url.endsWith("/agents")) return Response.json([{ id: "agent-id", handle: "coda" }]);
    return Response.json({ contact_cards: [{ handle: "coda", first_name: "Coda", image_url: null, kind: "agent", is_active: true }] });
  });
  const stdout: string[] = [], stderr: string[] = [];
  const run = (args: string[]) => runCLI(args, { configContext: context, fetch, isInteractive: false,
    consoleLogin: async () => config.console!, stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v) });
  return { run, fetch, stdout, stderr };
};

it("agents create --call-url sets the console call address after creation", async () => {
  const { run, fetch, stderr, stdout } = await setup();
  expect(await run(["agents", "create", "--handle", "coda", "--call-url", "wss://voice.example.com", "--json"]), stderr.join("")).toBe(0);
  expect(fetch).toHaveBeenCalledWith("https://api.staging.relayapp.im/v1/console/agents/agent-id", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ call_url: "wss://voice.example.com" }) }));
  expect(JSON.parse(stdout.join(""))).toMatchObject({ handle: "coda", token: "stored" });
});

it("agents update sets and clears call_url", async () => {
  const { run, fetch, stderr } = await setup();
  expect(await run(["--profile", "default", "agents", "update", "coda", "--name", " Coda ", "--about", " Hello ", "--call-url", "wss://voice.example.com", "--json"]), stderr.join("")).toBe(0);
  expect(fetch).toHaveBeenCalledWith("https://api.staging.relayapp.im/v1/contact_card?handle=coda", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ first_name: "Coda", about: "Hello", call_url: "wss://voice.example.com" }) }));
  expect(await run(["--profile", "default", "agents", "update", "coda", "--clear-call-url", "--json"])).toBe(0);
  expect(fetch).toHaveBeenCalledWith("https://api.staging.relayapp.im/v1/contact_card?handle=coda", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ call_url: null }) }));
});

it.each([ [["agents", "create"]], [["agents", "update", "coda"]] ])("refuses https:// call addresses before a request (%j)", async (args) => {
  const { run, fetch, stderr } = await setup();
  expect(await run([...args, "--call-url", "https://voice.example.com", "--json"])).not.toBe(0);
  expect(stderr.join("")).toContain("Must start with wss://");
  expect(fetch).not.toHaveBeenCalled();
});
