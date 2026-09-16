import { expect, it, vi } from "vitest";
import { createAgentWithPicture } from "./agent-create.js";
import type { AgentDependencies } from "./agents.js";
import { emptyConfig } from "./config.js";

it("preserves the server-invented identity and picture without any CLI picture request", async () => {
  const config = emptyConfig();
  const card = { handle: "brave_blue_cangoo", first_name: "Brave Blue Canada Goose", image_url: "https://cdn.relayapp.im/bird.png" };
  const provision = vi.fn<AgentDependencies["provision"]>(async () => ({ agent: card, token: "server-issued-secret" }));
  const deps = {
    read: async () => config,
    preflight: async () => undefined,
    update: async (change) => change(config),
    provision,
    env: {},
  } as AgentDependencies;
  const fetch = vi.fn();
  const created = await createAgentWithPicture({}, deps, fetch);
  expect(provision.mock.calls[0]?.[0]).toEqual({});
  expect(created.result).toMatchObject({ handle: card.handle, display_name: card.first_name, image_url: card.image_url, profile: card.handle });
  expect(config.profiles[card.handle]?.agent_token).toBe("server-issued-secret");
  expect(created.image).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
