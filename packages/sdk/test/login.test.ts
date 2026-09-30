import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import Relay, { verifyRelayIdToken } from "../src/index.js";

const ISSUER = "https://auth.staging.relayapp.im/api/auth";
const CLIENT_ID = "019f8e21-6c4a-7b1e-9d52-3f0a8c7e41b9";

const call = (fetch: ReturnType<typeof vi.fn>, index = 0) => {
  const [url, init] = fetch.mock.calls[index] as unknown as [URL, RequestInit];
  return { url: new URL(url), init };
};

describe("client.oauth2Client: the agent's OAuth2 client for Log in with Relay", () => {
  const client = { client_id: CLIENT_ID, redirect_uris: [], scopes: ["openid", "profile"], created_at: "2026-09-30T00:00:00.000Z", updated_at: "2026-09-30T00:00:00.000Z" };

  it("reads, updates and resets the secret with the agent's token", async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) =>
      Response.json({ client, client_secret: "rel_cs_x" }, { status: init?.method === "POST" && !String(_input).includes("reset") ? 201 : 200 }));
    const relay = new Relay({ apiKey: "agent-token", baseURL: "https://server.test", fetch });
    expect((await relay.oauth2Client.retrieve()).client_secret).toBe("rel_cs_x");
    await relay.oauth2Client.create();
    await relay.oauth2Client.update({ redirect_uris: ["https://youlearn.ai/cb"], scopes: ["openid", "profile", "email"] });
    await relay.oauth2Client.resetSecret();
    expect([call(fetch, 0).init.method, call(fetch, 0).url.pathname]).toEqual(["GET", "/v1/oauth2_client"]);
    expect([call(fetch, 1).init.method, call(fetch, 1).url.pathname]).toEqual(["POST", "/v1/oauth2_client"]);
    expect([call(fetch, 2).init.method, call(fetch, 2).url.pathname]).toEqual(["PATCH", "/v1/oauth2_client"]);
    expect(JSON.parse(String(call(fetch, 2).init.body))).toEqual({ redirect_uris: ["https://youlearn.ai/cb"], scopes: ["openid", "profile", "email"] });
    expect([call(fetch, 3).init.method, call(fetch, 3).url.pathname]).toEqual(["POST", "/v1/oauth2_client/reset_secret"]);
    expect(new Headers(call(fetch, 0).init.headers).get("authorization")).toBe("Bearer agent-token");
  });
});

describe("verifyRelayIdToken", () => {
  const setup = async (issuer = ISSUER) => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...await exportJWK(publicKey), kid: "k1", alg: "RS256", use: "sig" };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      return new Response("not found", { status: 404 });
    });
    const sign = (claims: Record<string, unknown>, patch: { expiresIn?: string; issuer?: string; audience?: string } = {}) =>
      new SignJWT({ name: "Ada", preferred_username: "ada", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(patch.issuer ?? issuer)
        .setAudience(patch.audience ?? CLIENT_ID)
        .setSubject("user-1")
        .setIssuedAt()
        .setExpirationTime(patch.expiresIn ?? "10m")
        .sign(privateKey);
    return { fetch, sign };
  };

  it("returns the claims of a token Relay signed for this client", async () => {
    const { fetch, sign } = await setup(`${ISSUER}/ok`);
    const claims = await verifyRelayIdToken(await sign({ nonce: "n1" }), { clientId: CLIENT_ID, issuer: `${ISSUER}/ok`, nonce: "n1", fetch });
    expect(claims).toMatchObject({ sub: "user-1", aud: CLIENT_ID, preferred_username: "ada", name: "Ada" });
  });

  it("refuses another client's token, an expired one, another issuer's, a wrong nonce, and a foreign key", async () => {
    const { fetch, sign } = await setup(`${ISSUER}/bad`);
    const options = { clientId: CLIENT_ID, issuer: `${ISSUER}/bad`, fetch };
    await expect(verifyRelayIdToken(await sign({}, { audience: "someone-else" }), options)).rejects.toThrow();
    await expect(verifyRelayIdToken(await sign({}, { expiresIn: "-5m" }), options)).rejects.toThrow();
    await expect(verifyRelayIdToken(await sign({}, { issuer: "https://evil.example" }), options)).rejects.toThrow();
    await expect(verifyRelayIdToken(await sign({ nonce: "a" }), { ...options, nonce: "b" })).rejects.toThrow(/nonce/);
    const other = await setup(`${ISSUER}/bad`);
    await expect(verifyRelayIdToken(await other.sign({}), options)).rejects.toThrow();
  });
});
