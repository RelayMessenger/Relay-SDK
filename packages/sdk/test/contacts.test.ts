import { describe, expect, it } from "vitest";
import Relay, { RelayAPIError, type ContactLookup } from "../src/index.js";

describe("public Contact lookup", () => {
  it.each(["user", "agent"] as const)("looks up a %s through the canonical POST body", async (kind) => {
    const contact: ContactLookup = {
      id: "01995bc0-0000-7000-8000-000000000003",
      handle: "alice",
      display_name: "Alice",
      kind,
      image_url: null,
      image_color: null,
      subtitle: null,
      verified: false,
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new Relay({
      apiKey: "fixture-token",
      baseURL: "https://api.example.test",
      maxRetries: 0,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ contact });
      },
    });

    expect(await client.contacts.lookup({ handle: " Alice " })).toEqual({ contact });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/contacts/lookup");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ handle: " Alice " });
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer fixture-token");
  });

  it.each([[404, 2001], [422, 1005]])("preserves the %i lookup error", async (status, code) => {
    const client = new Relay({
      apiKey: "fixture-token",
      maxRetries: 0,
      fetch: async () => Response.json({
        error: { code, message: "Fixture lookup refusal" },
      }, { status }),
    });

    const request = client.contacts.lookup({ handle: "alice" });
    await expect(request).rejects.toBeInstanceOf(RelayAPIError);
    await expect(request).rejects.toMatchObject({ status, code });
  });
});
