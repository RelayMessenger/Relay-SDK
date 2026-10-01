import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

/**
 * Log in with Relay: Relay is a standard OpenID Connect provider, so any
 * OpenID Connect library works (openid-client, Auth.js, Passport). This is
 * the one step a website that already holds an ID token needs: check its
 * signature against Relay's published keys, its issuer, its audience (your
 * client ID, which is your agent's ID) and its expiry. jose does the
 * checking (RFC 7519, OpenID Connect Core 3.1.3.7).
 */

/** Relay's OpenID Connect issuer. Staging is `https://auth.staging.relayapp.im/api/auth`. */
export const RELAY_ISSUER = "https://auth.relayapp.im/api/auth";

/** The claims Relay puts in an ID token. `email` and `phone_number` only when the person shared them. */
export interface RelayIdTokenClaims extends JWTPayload {
  /** The person's Relay user ID, stable for your client. */
  sub: string;
  /** Your client ID: your agent's ID. */
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
  /** The person's Relay @handle, without the @. */
  preferred_username?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  /** E.164, only with the `phone` scope and when the person shared it. */
  phone_number?: string;
  phone_number_verified?: boolean;
}

export interface VerifyRelayIdTokenOptions {
  /** Your client ID, which is your agent's ID. */
  clientId: string;
  /** Defaults to {@link RELAY_ISSUER}. */
  issuer?: string;
  /** The nonce your login request sent, when it sent one. */
  nonce?: string;
  /** Seconds of clock skew to allow on `exp` and `iat`. Defaults to 60. */
  clockTolerance?: number;
  /** For tests and runtimes without a global fetch. */
  fetch?: typeof globalThis.fetch;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const keysFor = async (issuer: string, fetcher: typeof globalThis.fetch) => {
  const cached = keySets.get(issuer);
  if (cached) return cached;
  const response = await fetcher(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`Relay's OpenID configuration answered ${response.status}.`);
  const discovery = await response.json() as { issuer?: string; jwks_uri?: string };
  if (discovery.issuer !== issuer || !discovery.jwks_uri) {
    throw new Error("Relay's OpenID configuration does not match the issuer.");
  }
  const keys = createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: fetcher });
  keySets.set(issuer, keys);
  return keys;
};

/**
 * Verifies a Relay ID token and returns its claims. Throws when the
 * signature, issuer, audience, expiry or nonce is wrong.
 */
export async function verifyRelayIdToken(
  idToken: string,
  options: VerifyRelayIdTokenOptions,
): Promise<RelayIdTokenClaims> {
  const issuer = (options.issuer ?? RELAY_ISSUER).replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const { payload } = await jwtVerify(idToken, await keysFor(issuer, fetcher), {
    issuer,
    audience: options.clientId,
    algorithms: ["RS256"],
    clockTolerance: options.clockTolerance ?? 60,
    requiredClaims: ["sub", "exp", "iat"],
  });
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new Error("The ID token's nonce does not match the login request.");
  }
  return payload as RelayIdTokenClaims;
}
