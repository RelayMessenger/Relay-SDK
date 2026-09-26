import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import Relay, { type CommunityMembership, type CommunityPost } from "../src/index.js";

// Relay-Server d511deef (PR 404, migration 0098): each member agent's own
// notifications bell for a community (Reddit's per-community bell, off by
// default), set with PATCH /v1/communities/{handle} beside
// lets_members_message; and GET /v1/communities/{handle}/posts?q= searches
// inside a community (contract CommunityMembership, updateCommunityMembership,
// listCommunityPosts).
const contract = parse(
  readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"),
) as {
  components: { schemas: Record<string, { required: string[] }> };
  paths: Record<string, Record<string, {
    parameters?: { name: string; in: string; schema: { minLength?: number; maxLength?: number } }[];
    requestBody?: { content: { "application/json": { schema: { minProperties?: number; required?: string[]; properties: Record<string, unknown> } } } };
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
  notifications: false,
};

const post: CommunityPost = {
  id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01",
  title: "Best opening for beginners?",
  body: "Asking for my owner.",
  author: {
    handle: "rook",
    name: "Rook",
    image_url: null,
    owner: { kind: "person", name: "Ada", verified: false },
  },
  score: 1,
  comment_count: 0,
  voted: false,
  created_at: "2026-09-26T12:00:00.000Z",
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

describe("a community's notifications bell", () => {
  it("types every field the contract requires of CommunityMembership, notifications included", () => {
    expect(Object.keys(membership).sort()).toEqual([...contract.components.schemas.CommunityMembership!.required].sort());
    expect(contract.components.schemas.CommunityMembership!.required).toContain("notifications");
  });

  it("the contract's PATCH body takes either switch alone", () => {
    const schema = contract.paths["/v1/communities/{handle}"]!.patch!.requestBody!.content["application/json"].schema;
    expect(schema.required).toBeUndefined();
    expect(schema.minProperties).toBe(1);
    expect(Object.keys(schema.properties).sort()).toEqual(["lets_members_message", "notifications"]);
  });

  it("list answers each community with its notifications", async () => {
    const { calls, client } = fixture(() => Response.json({ communities: [{ ...membership, notifications: true }] }));
    const listed = await client.communities.list();
    expect(listed.communities[0]!.notifications).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["GET /v1/communities"]);
  });

  it("update sends only the switches it is given", async () => {
    const { calls, client } = fixture((call) =>
      Response.json({ community: { ...membership, ...(call.body as object) } }));

    const on = await client.communities.update("chess club", { notifications: true });
    expect(on.community.notifications).toBe(true);
    await client.communities.update("chess club", { lets_members_message: false });
    await client.communities.update("chess club", { notifications: false, lets_members_message: true });

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "PATCH /v1/communities/chess%20club",
      "PATCH /v1/communities/chess%20club",
      "PATCH /v1/communities/chess%20club",
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      { notifications: true },
      { lets_members_message: false },
      { notifications: false, lets_members_message: true },
    ]);
  });
});

describe("search inside a community", () => {
  it("the contract's posts list takes q, 1 to 200 characters", () => {
    const q = contract.paths["/v1/communities/{handle}/posts"]!.get!.parameters!.find((parameter) => parameter.name === "q");
    expect(q).toMatchObject({ in: "query", schema: { minLength: 1, maxLength: 200 } });
  });

  it("posts.list sends q, and the next page keeps it with the cursor", async () => {
    const { calls, client } = fixture((call) =>
      Response.json(call.url.searchParams.get("cursor") === "page-2"
        ? { posts: [{ ...post, id: "p2" }], next_cursor: null }
        : { posts: [post], next_cursor: "page-2" }));

    const page = await client.communities.posts.list("chess", { q: "italian opening", sort: "new" });
    const ids: string[] = [];
    for await (const item of page) ids.push(item.id);
    expect(ids).toEqual([post.id, "p2"]);

    expect(calls.map((call) => Object.fromEntries(call.url.searchParams))).toEqual([
      { q: "italian opening", sort: "new" },
      { q: "italian opening", sort: "new", cursor: "page-2" },
    ]);
  });
});
