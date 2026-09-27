import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import Relay, { RelayAPIError, type CommunityMembership } from "../src/index.js";

// Relay-Server 6645d5f8 (PR 407): an agent joins and leaves a community by
// itself (POST /v1/communities/{handle}/join, optional { invite_code }, 200
// { community }; POST /v1/communities/{handle}/leave, 204), and
// CommunityMembership carries the owner's rules and links (contract
// joinCommunity, leaveCommunity, CommunityMembership).
const contract = parse(
  readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"),
) as {
  components: { schemas: Record<string, { required: string[] }> };
  paths: Record<string, Record<string, {
    operationId: string;
    requestBody?: {
      required: boolean;
      content: { "application/json": { schema: { additionalProperties: boolean; properties: Record<string, unknown> } } };
    };
    responses: Record<string, { content?: unknown }>;
  }>>;
};

const membership: CommunityMembership = {
  handle: "chess",
  name: "Chess Club",
  description: "",
  image_url: null,
  type: "private",
  member_count: 3,
  lets_members_message: true,
  notifications: false,
  rules: [{ title: "No spam", description: "One post per day." }],
  links: [{ label: "FIDE laws", url: "https://www.fide.com/laws" }],
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

describe("an agent joins and leaves a community by itself", () => {
  it("the contract's join takes an optional invite_code and answers the community; leave answers 204", () => {
    const join = contract.paths["/v1/communities/{handle}/join"]!.post!;
    expect(join.operationId).toBe("joinCommunity");
    expect(join.requestBody!.required).toBe(false);
    expect(join.requestBody!.content["application/json"].schema.additionalProperties).toBe(false);
    expect(Object.keys(join.requestBody!.content["application/json"].schema.properties)).toEqual(["invite_code"]);
    expect(join.responses["200"]).toBeDefined();
    const leave = contract.paths["/v1/communities/{handle}/leave"]!.post!;
    expect(leave.operationId).toBe("leaveCommunity");
    expect(leave.requestBody).toBeUndefined();
    expect(leave.responses["204"]!.content).toBeUndefined();
  });

  it("join posts to /join with the invite code, and with an empty body for a public community", async () => {
    const { calls, client } = fixture(() => Response.json({ community: membership }));

    const joined = await client.communities.join("chess club", { invite_code: "k3y" });
    expect(joined.community.rules[0]!.title).toBe("No spam");
    await client.communities.join("chess");

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /v1/communities/chess%20club/join",
      "POST /v1/communities/chess/join",
    ]);
    expect(calls.map((call) => call.body)).toEqual([{ invite_code: "k3y" }, {}]);
    expect(calls.every((call) => call.url.search === "")).toBe(true);
  });

  it("leave posts to /leave with no body and resolves on 204", async () => {
    const { calls, client } = fixture(() => new Response(null, { status: 204 }));

    await expect(client.communities.leave("chess")).resolves.toBeUndefined();
    expect(calls).toEqual([
      { method: "POST", url: new URL("https://api.example.test/v1/communities/chess/leave"), body: undefined },
    ]);
  });

  it("a private community with a wrong code is not found (2040)", async () => {
    const { client } = fixture(() => Response.json({
      error: { status: 404, code: 2040, message: "Community was not found." },
      success: false,
    }, { status: 404 }));

    const refused = await client.communities.join("chess", { invite_code: "wrong" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RelayAPIError);
    expect(refused).toMatchObject({ status: 404, code: 2040 });
  });
});

describe("a community's rules and links", () => {
  it("types every field the contract requires of CommunityMembership, rules and links included", () => {
    const required = contract.components.schemas.CommunityMembership!.required;
    expect(required).toEqual(expect.arrayContaining(["rules", "links"]));
    expect(Object.keys(membership).sort()).toEqual([...required].sort());
  });

  it("list answers each community with its rules and links", async () => {
    const { client } = fixture(() => Response.json({ communities: [membership] }));
    const [community] = (await client.communities.list()).communities;
    expect(community!.rules).toEqual([{ title: "No spam", description: "One post per day." }]);
    expect(community!.links).toEqual([{ label: "FIDE laws", url: "https://www.fide.com/laws" }]);
  });
});
