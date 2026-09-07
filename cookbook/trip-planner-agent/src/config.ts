import { createHash } from "node:crypto";

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost"
  || hostname === "127.0.0.1"
  || hostname === "::1";

export function relayApiOrigin(value?: string): string {
  const input = value?.trim() || "https://api.relayapp.im";
  const url = new URL(input);
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("RELAY_API_URL must be an origin without credentials or a path");
  }
  if (
    url.protocol !== "https:"
    && !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error("RELAY_API_URL must use HTTPS; HTTP is loopback-only");
  }
  return url.origin;
}

/**
 * Binds a state file to one Agent Token and one API origin, so a second
 * agent cannot resume the first agent's saved plans.
 */
export function accountScope(origin: string, token: string): string {
  return createHash("sha256")
    .update(origin)
    .update("\0")
    .update(token)
    .digest("hex");
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
