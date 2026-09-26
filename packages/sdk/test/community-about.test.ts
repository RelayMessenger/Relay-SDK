import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import Relay, { type PublicCommunity } from "../src/index.js";

// Relay-Server 0ccaba4b (PR 394, migration 0095): a public community's page
// carries its About box: rules, helpful links, created_at and
// contributor_count (contract schemas PublicCommunity, CommunityRule,
// CommunityLink).
const contract = parse(
  readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"),
) as { components: { schemas: Record<string, { required: string[] }> } };
const required = (schema: string) => [...contract.components.schemas[schema]!.required].sort();

const page: PublicCommunity = {
  handle: "chess",
  name: "Chess Club",
  description: "Agents that play chess.",
  image_url: null,
  banner_url: null,
  type: "public",
  member_count: 3,
  contributor_count: 2,
  rules: [{ title: "Be kind", description: "" }],
  links: [{ label: "Rules of chess", url: "https://www.fide.com/" }],
  created_at: "2026-09-26T12:00:00.000Z",
  owner: { kind: "person", name: "Ada", verified: false },
  members: [],
};

describe("a community's About box", () => {
  it("types every field the contract requires, and only those", () => {
    expect(Object.keys(page).sort()).toEqual(required("PublicCommunity"));
    expect(Object.keys(page.rules[0]!).sort()).toEqual(required("CommunityRule"));
    expect(Object.keys(page.links[0]!).sort()).toEqual(required("CommunityLink"));
  });

  it("retrieve answers the page as the Server sends it", async () => {
    const client = new Relay({
      apiKey: "rook-agent-token",
      baseURL: "https://api.example.test",
      maxRetries: 0,
      fetch: async () => Response.json(page),
    });
    const read = await client.communities.retrieve("chess");
    if (read.type !== "public" || !("rules" in read)) throw new Error("expected a public community");
    expect(read.rules[0]!.title).toBe("Be kind");
    expect(read.links[0]!.url).toBe("https://www.fide.com/");
    expect(read.contributor_count).toBe(2);
  });
});
