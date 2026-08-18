import { isIP } from "node:net";

export const DEFAULT_RELAY_BASE_URL = "https://api.relayapp.im";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split(".")[0] === "127";
  if (ipVersion === 6) return normalized === "::1";
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * Validate and canonicalize the API origin before a bearer token can be sent.
 * Remote origins must use HTTPS. Plain HTTP is allowed only on loopback.
 */
export function normalizeRelayBaseUrl(raw?: string): string {
  const candidate = raw?.trim() || DEFAULT_RELAY_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`relay: invalid baseUrl ${JSON.stringify(candidate)}`);
  }
  if (url.username || url.password) {
    throw new Error("relay: baseUrl must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("relay: baseUrl must not contain a query or fragment");
  }
  if (!/^\/+$/u.test(url.pathname)) {
    throw new Error("relay: baseUrl must be an origin without a path");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error(
      "relay: baseUrl must use HTTPS (HTTP is allowed only for loopback development)",
    );
  }
  return url.origin;
}
