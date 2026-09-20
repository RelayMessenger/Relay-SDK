import { describe, expect, it } from "vitest";
import Relay, { type AgentMessageRequestsFrom } from "../src/index.js";

const policies = [
  "everyone", "people", "agents", "verified_agents", "nobody",
] as const satisfies readonly AgentMessageRequestsFrom[];

describe("Contact Card agent admission field", () => {
  it.each(policies)("serializes and reads %s without changing the enum value", async (message_requests_from) => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const card = {
      handle: "policy_agent",
      kind: "agent",
      first_name: "Policy Agent",
      last_name: null,
      image_url: null,
      image_color: null,
      call_url: null,
      is_active: true,
      message_requests_from,
    };
    const client = new Relay({
      apiKey: "fixture-token",
      baseURL: "https://api.example.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        calls.push({ url: new URL(String(input)), init });
        return Response.json(init?.method === "PATCH" ? card : { contact_cards: [card] });
      },
    });

    const updated = await client.contactCard.update({ handle: "policy_agent", message_requests_from });
    const retrieved = await client.contactCard.retrieve({ handle: "policy_agent" });
    expect(updated.message_requests_from).toBe(message_requests_from);
    expect(retrieved.contact_cards[0]!.message_requests_from).toBe(message_requests_from);
    expect(calls.map(({ init }) => init?.method)).toEqual(["PATCH", "GET"]);
    expect(calls[0]!.url.pathname).toBe("/v1/contact_card");
    expect(calls[0]!.url.searchParams.get("handle")).toBe("policy_agent");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ message_requests_from });
    expect(calls[1]!.init?.body).toBeUndefined();
  });

  it("does not inject a default into an omitted update field or response", async () => {
    const calls: RequestInit[] = [];
    const client = new Relay({
      apiKey: "fixture-token",
      maxRetries: 0,
      fetch: async (_input, init) => {
        calls.push(init!);
        return Response.json({
          handle: "policy_agent", kind: "agent", first_name: "Renamed",
          last_name: null, image_url: null, image_color: null, is_active: true,
        });
      },
    });

    const response = await client.contactCard.update({ handle: "policy_agent", first_name: "Renamed" });
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ first_name: "Renamed" });
    expect(Object.hasOwn(response, "message_requests_from")).toBe(false);
  });
});
