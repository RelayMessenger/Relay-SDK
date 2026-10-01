import { describe, expect, it } from "vitest";
import Relay, {
  RelayAPIError,
  type AgentRatingListResponse,
  type SuggestedAgentListResponse,
} from "../src/index.js";

interface Captured { url: URL; method: string; body: unknown }

const relayWith = (reply: (call: Captured) => Response) => {
  const calls: Captured[] = [];
  const relay = new Relay({ apiKey: "fixture-token", maxRetries: 0, fetch: async (input, init) => {
    const call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return reply(call);
  } });
  return { relay, calls };
};

const rating = { stars: 4, review: "Kind and quick.", created_at: "2026-09-30T12:00:00Z", updated_at: "2026-09-30T12:00:00Z" };

describe("ratings", () => {
  it("sets stars and a review with PUT on the agent's rating", async () => {
    const { relay, calls } = relayWith(() => Response.json({ rating }));
    expect(await relay.ratings.set("brave_cangoo", { stars: 4, review: "Kind and quick." })).toEqual({ rating });
    expect(calls).toEqual([{
      url: new URL("https://api.relayapp.im/v1/contacts/brave_cangoo/rating"),
      method: "PUT",
      body: { stars: 4, review: "Kind and quick." },
    }]);
  });

  it("deletes the rating and requires 204", async () => {
    const { relay, calls } = relayWith(() => new Response(null, { status: 204 }));
    await expect(relay.ratings.delete("brave_cangoo")).resolves.toBeUndefined();
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([["DELETE", "/v1/contacts/brave_cangoo/rating"]]);
    const wrong = relayWith(() => Response.json({}, { status: 200 }));
    await expect(wrong.relay.ratings.delete("brave_cangoo")).rejects.toThrow();
  });

  it("lists the summary and reviews from the plural ratings path", async () => {
    const list: AgentRatingListResponse = {
      summary: { average: 4.5, count: 2, histogram: [0, 0, 0, 1, 1] },
      reviews: [{
        rater: { handle: "ada", display_name: "Ada", kind: "user", image_url: null, image_color: "0B75FF", verified: false },
        stars: 5, review: "Great.", updated_at: "2026-09-30T12:00:00Z",
      }],
    };
    const { relay, calls } = relayWith(() => Response.json(list));
    expect(await relay.ratings.list("brave_cangoo")).toEqual(list);
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([["GET", "/v1/contacts/brave_cangoo/ratings"]]);
  });

  it("keeps the exchange-too-short refusal as a RelayAPIError", async () => {
    const { relay } = relayWith(() => Response.json({ error: { code: 1005, message: "ten messages and three replies" } }, { status: 403 }));
    const request = relay.ratings.set("brave_cangoo", { stars: 1 });
    await expect(request).rejects.toBeInstanceOf(RelayAPIError);
    await expect(request).rejects.toMatchObject({ status: 403, code: 1005 });
  });
});

describe("person-only discovery", () => {
  it("lists suggested agents with limit and contacts as query parameters", async () => {
    const answer: SuggestedAgentListResponse = { agents: [{
      handle: "lupe", name: "Lupe", subtitle: null, image_url: null, image_color: null,
      verified: false, contacts: 3, reason: "contacts",
    }] };
    const { relay, calls } = relayWith(() => Response.json(answer));
    expect(await relay.agents.listSuggested({ limit: 5, contacts: "lupe:3,derek:2" })).toEqual(answer);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v1/agents/suggested");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ limit: "5", contacts: "lupe:3,derek:2" });
    await relay.agents.listSuggested();
    expect(calls[1]!.url.search).toBe("");
  });

  it("counts agents from hashed numbers in the POST body", async () => {
    const hash = "9f".repeat(32);
    const { relay, calls } = relayWith(() => Response.json({ agents: [{ handle: "lupe", contacts: 2 }] }));
    expect(await relay.addressBook.countAgents({ phone_hashes: [hash] })).toEqual({ agents: [{ handle: "lupe", contacts: 2 }] });
    expect(calls).toEqual([{ url: new URL("https://api.relayapp.im/v1/address_book/agent_counts"), method: "POST", body: { phone_hashes: [hash] } }]);
  });

  it("creates an agent request and requires 201", async () => {
    const stored = { id: "0b4a6f3e-1c2d-4e5f-8a9b-7c6d5e4f3a2b", query: "tenant lawyer", what: "Read my lease", created_at: "2026-09-30T12:00:00Z" };
    const { relay, calls } = relayWith(() => Response.json(stored, { status: 201 }));
    expect(await relay.agentRequests.create({ query: "tenant lawyer", what: "Read my lease" })).toEqual(stored);
    expect(calls).toEqual([{ url: new URL("https://api.relayapp.im/v1/agent_requests"), method: "POST", body: { query: "tenant lawyer", what: "Read my lease" } }]);
    const wrong = relayWith(() => Response.json(stored, { status: 200 }));
    await expect(wrong.relay.agentRequests.create({ query: "q", what: "w" })).rejects.toThrow();
  });

  it("surfaces the agent-token refusal (2003) unchanged", async () => {
    const { relay } = relayWith(() => Response.json({ error: { code: 2003, message: "The caller is an agent." } }, { status: 403 }));
    await expect(relay.agents.listSuggested()).rejects.toMatchObject({ status: 403, code: 2003 });
  });
});
