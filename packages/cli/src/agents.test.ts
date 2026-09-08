import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import { createAgent, deleteAgent, listAgents, type AgentDependencies } from "./agents.js";
import { defaultCreationApiURL, emptyConfig, type RelayConfig, type ResolvedAuth } from "./config.js";
import { runCLI } from "./program.js";

const privateContext = { env: { RELAY_CONFIG_PATH: join(mkdtempSync(join(tmpdir(), "relay-unit-config-")), "config.json") } };
const secret = "one-time-secret-not-for-output";
// Creation targets the origin the version under test selects (see config.ts).
const creationOrigin = defaultCreationApiURL();
const card = { handle: "brave_cangoo.dev", first_name: "Brave Canada Goose", last_name: null, image_url: null, is_active: true, kind: "agent" as const };
const response = { agent: card, secret, share_url: "https://go.test/@brave_cangoo.dev" };
function setup(initial: RelayConfig = emptyConfig()) {
  let config = structuredClone(initial);
  const auth: ResolvedAuth = { profile: "default", apiURL: "https://api.relayapp.im", token: secret, tokenSource: "profile", configPath: "/not-used" };
  const remove = vi.fn(async () => undefined);
  const retrieve = vi.fn(async () => ({ contact_cards: [card] }));
  const deps: AgentDependencies = {
    read: vi.fn(async () => structuredClone(config)),
    preflight: vi.fn(async () => undefined),
    update: vi.fn(async (change) => { const next = structuredClone(config); const result = change(next); config = next; return result; }),
    bootstrap: vi.fn(async () => response),
    client: vi.fn(() => ({ contactCard: { retrieve }, agents: { delete: remove } }) as unknown as Relay),
    auth: vi.fn(async () => auth), env: {},
  };
  return { deps, config: () => config, auth, remove, retrieve };
}

describe("pure agent command handlers", () => {
  it("creates a named identity while preserving default and existing credentials", async () => {
    const test = setup();
    const result = await createAgent({}, test.deps);
    expect(result).toEqual({ profile: card.handle, handle: card.handle, display_name: card.first_name, image_url: card.image_url, share_url: response.share_url, api_url: creationOrigin, token: "stored" });
    // A CLI record is one active agent: the contact-card fields that only make sense for a person or a list never appear.
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(["agent", "kind", "last_name", "is_active", "first_name"]));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(test.config().profiles[card.handle]?.agent_token).toBe(secret);
    expect(test.config().current_profile).toBe("default");
    await createAgent({}, test.deps);
    expect(test.config().profiles[`${card.handle}-2`]?.agent_token).toBe(secret);
  });
  it("rejects existing explicit profiles and invalid labels before POST", async () => {
    const { deps } = setup();
    await expect(createAgent({ profile: "default" }, deps)).rejects.toThrow("exists");
    await expect(createAgent({ tokenName: "" }, deps)).rejects.toThrow("1 to 80 characters");
    await expect(createAgent({ tokenName: "label\ncontrol" }, deps)).rejects.toThrow("control characters");
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });
  it("does not leak bootstrap or persistence errors or retry", async () => {
    const { deps } = setup();
    vi.mocked(deps.bootstrap).mockRejectedValueOnce(new Error(secret));
    await expect(createAgent({}, deps)).rejects.toThrow("may or may not have been created");
    expect(deps.bootstrap).toHaveBeenCalledTimes(1);
    vi.mocked(deps.update).mockRejectedValueOnce(new Error(secret));
    await expect(createAgent({}, deps)).rejects.toThrow("could not be saved");
    expect(deps.bootstrap).toHaveBeenCalledTimes(2);
  });
  it("uses saved credentials and origins, not one ENV override, for inventory", async () => {
    const config = emptyConfig();
    config.profiles.one = { api_url: "https://one.test", agent_token: "token-one" };
    config.profiles.two = { api_url: "https://two.test", agent_token: "token-two" };
    const { deps, retrieve } = setup(config);
    deps.env = { RELAY_AGENT_TOKEN: "environment-secret", RELAY_API_URL: "https://wrong.test" };
    retrieve.mockRejectedValueOnce(new Error("token-one"));
    const result = await listAgents(deps);
    expect(deps.client).toHaveBeenNthCalledWith(1, "token-one", "https://one.test");
    expect(deps.client).toHaveBeenNthCalledWith(2, "token-two", "https://two.test");
    expect(deps.auth).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/token-one|token-two|environment-secret/);
    expect(result.agents).toHaveLength(2);
  });
  it("keeps every credential on failed/uncertain deletion", async () => {
    const config = emptyConfig(); config.profiles.default!.agent_token = secret;
    const { deps, remove, config: saved } = setup(config);
    remove.mockRejectedValueOnce(new Error("409 pending events"));
    await expect(deleteAgent(card.handle, "default", deps)).rejects.toThrow("the token saved on this computer is unchanged");
    expect(deps.update).not.toHaveBeenCalled();
    expect(saved()).toEqual(config);
  });
  it("only clears the intended saved credential after confirmed deletion", async () => {
    const config = emptyConfig(); config.profiles.default!.agent_token = secret;
    config.profiles.other = { agent_token: "keep-me" };
    const { deps, config: saved, remove } = setup(config);
    await deleteAgent(card.handle, "default", deps);
    expect(remove).toHaveBeenCalledWith(card.handle, { maxRetries: 0 });
    expect(saved().profiles.default!.agent_token).toBeUndefined();
    expect(saved().profiles.other!.agent_token).toBe("keep-me");
  });
  it.each(["token", "origin"])("does not clear a profile when ENV overrides its %s", async (override) => {
    const config = emptyConfig(); config.profiles.default!.agent_token = secret;
    const { deps, auth, config: saved } = setup(config);
    if (override === "token") auth.token = "different-env-token";
    else auth.apiURL = "https://different.test";
    await deleteAgent(card.handle, "default", deps);
    expect(saved()).toEqual(config);
    expect(deps.update).toHaveBeenCalledOnce();
  });
});

describe("agent CLI program", () => {
  it("routes create/list/delete with JSON output and no secret", async () => {
    const { deps } = setup();
    const stdout: string[] = []; const stderr: string[] = [];
    const options = { agents: deps, configContext: privateContext, stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) };
    expect(await runCLI(["--profile", "new-profile", "agents", "create", "--token-name", "Laptop", "--json"], options)).toBe(0);
    expect(deps.bootstrap).toHaveBeenCalledWith({ token_name: "Laptop" }, { baseURL: creationOrigin, maxRetries: 0 });
    expect(await runCLI(["agents", "list", "--json"], options)).toBe(0);
    expect(await runCLI(["--profile", "default", "agents", "delete", card.handle, "--json"], options)).toBe(0);
    expect(stdout.join("")).not.toContain(secret);
    expect(stdout.join("")).not.toContain('"secret"');
    expect(stderr).toEqual([]);
  });
  it("prints the public link and QR code, and never the token, in human mode", async () => {
    const { deps } = setup(); const stdout: string[] = [];
    expect(await runCLI(["agents", "create"], { agents: deps, configContext: privateContext, stdout: (s) => stdout.push(s) })).toBe(0);
    expect(stdout.join("")).toContain(response.share_url);
    expect(stdout.join("")).not.toContain(secret);
    expect(stdout.length).toBeGreaterThan(1);
  });
});

it("reports safe rate-limit status/code without reflecting a server message", async () => {
  const { RelayAPIError } = await import("@relaymessenger/sdk");
  const { deps } = setup();
  vi.mocked(deps.bootstrap).mockRejectedValue(new RelayAPIError(secret, { status: 429, code: 2008, retryAfter: 60 }));
  const error = await createAgent({}, deps).catch((error: Error) => error);
  expect(String(error)).toContain("Relay said: error 429, code 2008.");
  expect(String(error)).toContain("code 2008");
  expect(String(error)).toContain("Try again in 60 seconds.");
  expect(String(error)).not.toContain(secret);
  expect(deps.bootstrap).toHaveBeenCalledOnce();
});

it("never reflects a newly issued credential even inside unexpected response metadata", async () => {
  const { deps } = setup();
  vi.mocked(deps.bootstrap).mockResolvedValue({ ...response, agent: { ...card, first_name: secret }, share_url: `https://go.test/?unexpected=${secret}` });
  const result = await createAgent({}, deps);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.handle).toBe(card.handle);
  expect(result.token).toBe("stored");
});

it("storage preflight rejection sends no creation request", async () => {
  const { deps } = setup(); vi.mocked(deps.preflight).mockRejectedValue(new Error("unwritable"));
  await expect(createAgent({}, deps)).rejects.toThrow("it did not create the agent");
  expect(deps.bootstrap).not.toHaveBeenCalled(); expect(deps.update).not.toHaveBeenCalled();
});

it("post-create storage failure reports assigned handle and actual local outcome, never the secret", async () => {
  const first = setup(); vi.mocked(first.deps.update).mockRejectedValue(new Error(secret));
  const lost = await createAgent({}, first.deps).catch((error: Error) => error.message);
  expect(lost).toContain(`@${card.handle}`); expect(lost).toContain("could not be saved"); expect(lost).toContain("it cannot get that token back"); expect(lost).not.toContain(secret);
  const second = setup(); const write = second.deps.update;
  second.deps.update = async (change) => { await write(change); throw new Error("final security verification failed"); };
  const saved = await createAgent({}, second.deps).catch((error: Error) => error.message);
  expect(saved).toContain(`@${card.handle}`); expect(saved).toContain("is in your Relay config file"); expect(saved).not.toContain(secret);
  expect(second.deps.bootstrap).toHaveBeenCalledOnce();
});
