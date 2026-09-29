import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import Relay, { type CommunityMembership } from "../src/index.js";

// The community feed is removed: no posts, comments, votes, post search or
// notifications bell. A membership keeps one switch of its own,
// lets_members_message, set with PATCH /v1/communities/{handle} (contract
// CommunityMembership, updateCommunityMembership).
const contract = parse(
  readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"),
) as {
  components: { schemas: Record<string, { required: string[] }> };
  paths: Record<string, Record<string, {
    requestBody?: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } };
  }>>;
};

const membership: CommunityMembership = {
  handle: "chess",
  name: "Chess Club",
  description: "",
  image_url: null,
  type: "public",
  member_count: 3,
  lets_members_message: true,
  rules: [],
  links: [],
};

interface Captured {
  method: string;
  url: URL;
  body: unknown;
}

const fixture = (answer: (call: Captured) => Response) => {
  const calls: Captured[] = [];
  const client = new Relay({
    apiKey: "rook-agent-token",
    baseURL: "https://api.example.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        url: new URL(input instanceof Request ? input.url : String(input)),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      };
      calls.push(call);
      return answer(call);
    },
  });
  return { calls, client };
};

describe("a community membership", () => {
  it("types every field the contract requires of CommunityMembership, and only those", () => {
    expect(Object.keys(membership).sort()).toEqual([...contract.components.schemas.CommunityMembership!.required].sort());
  });

  it("the contract's PATCH body takes only lets_members_message", () => {
    const schema = contract.paths["/v1/communities/{handle}"]!.patch!.requestBody!.content["application/json"].schema;
    expect(Object.keys(schema.properties)).toEqual(["lets_members_message"]);
  });

  it("the contract has no community posts", () => {
    expect(Object.keys(contract.paths).filter((path) => path.startsWith("/v1/communities/{handle}/posts"))).toEqual([]);
  });

  it("update sends lets_members_message", async () => {
    const { calls, client } = fixture((call) =>
      Response.json({ community: { ...membership, ...(call.body as object) } }));

    const off = await client.communities.update("chess club", { lets_members_message: false });
    expect(off.community.lets_members_message).toBe(false);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["PATCH /v1/communities/chess%20club"]);
    expect(calls.map((call) => call.body)).toEqual([{ lets_members_message: false }]);
  });

  it("has no posts resource", () => {
    const { client } = fixture(() => Response.json({}));
    expect("posts" in client.communities).toBe(false);
  });
});
