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

/** The namespaced ID token claim that carries the person's Relay id. */
export const RELAY_USER_ID_CLAIM = "https://relayapp.im/user_id";

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
  /**
   * The person's Relay id: the `id` your agent sees on person objects in its
   * chats, so you can link this login to the person who messages your agent.
   * Only with `openid` and `profile`, and only when the person has a Relay
   * profile. `sub` is a different id.
   */
  [RELAY_USER_ID_CLAIM]?: string;
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
  /** Request timeout in milliseconds for OIDC discovery and JWKS fetches. Defaults to 10000. */
  timeoutMs?: number;
  /** For tests and runtimes without a global fetch. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_OIDC_TIMEOUT_MS = 10_000;
const KEY_SET_CACHE_LIMIT = 64;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const assertSafeOidcUrl = (raw: string, label: string): URL => {
  const url = new URL(raw);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(`${label} must use HTTPS (http is allowed only for loopback).`);
};

const keySetsByFetch = new WeakMap<
  typeof globalThis.fetch,
  Map<string, ReturnType<typeof createRemoteJWKSet>>
>();

const keysFor = async (
  issuer: string,
  fetcher: typeof globalThis.fetch,
  timeoutMs: number,
) => {
  assertSafeOidcUrl(issuer, "Relay OpenID issuer");
  let cache = keySetsByFetch.get(fetcher);
  const cached = cache?.get(issuer);
  if (cached) return cached;
  const boundFetcher = fetcher.bind(globalThis);
  const response = await boundFetcher(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Relay's OpenID configuration answered ${response.status}.`);
  const discovery = await response.json() as { issuer?: string; jwks_uri?: string };
  if (discovery.issuer !== issuer || !discovery.jwks_uri) {
    throw new Error("Relay's OpenID configuration does not match the issuer.");
  }
  const jwksUrl = assertSafeOidcUrl(discovery.jwks_uri, "Relay OpenID jwks_uri");
  const keys = createRemoteJWKSet(jwksUrl, {
    [customFetch]: boundFetcher,
    timeoutDuration: timeoutMs,
  });
  if (!cache) {
    cache = new Map();
    keySetsByFetch.set(fetcher, cache);
  }
  cache.delete(issuer);
  cache.set(issuer, keys);
  while (cache.size > KEY_SET_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_OIDC_TIMEOUT_MS;
  const { payload } = await jwtVerify(idToken, await keysFor(issuer, fetcher, timeoutMs), {
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
