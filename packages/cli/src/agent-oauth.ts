import { findAgent, type ConsoleRequest } from "./agent-access.js";
import { CliError } from "./error-codes.js";

/**
 * Log in with Relay: an agent's OAuth2 client, read and changed through the
 * same Relay Console routes its OAuth2 tab uses (Relay-Console
 * apps/api/src/routes/agents.ts: GET and PATCH /orgs/:orgId/agents/:id/oauth2,
 * POST /orgs/:orgId/agents/:id/oauth2/reset-secret). The client ID is the
 * agent's ID. The first read makes the client and shows its secret once.
 */

export const OAUTH_SCOPES = ["openid", "profile", "email", "phone"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  scopes: OAuthScope[];
  created_at: string;
  updated_at: string;
}
interface OAuthClientResponse { client: OAuthClient; client_secret?: string }

const present = (handle: string, response: OAuthClientResponse) => ({
  handle: handle.trim().replace(/^@/u, "").toLowerCase(),
  client_id: response.client.client_id,
  redirect_uris: response.client.redirect_uris,
  scopes: response.client.scopes,
  ...(response.client_secret ? { client_secret: response.client_secret } : {}),
});

const read = async (request: ConsoleRequest, handle: string) => {
  const { path } = await findAgent(request, handle);
  return { path, response: await request<OAuthClientResponse>(`${path}/oauth2`) };
};

const patch = (request: ConsoleRequest, path: string, body: { redirect_uris?: string[]; scopes?: string[] }) =>
  request<OAuthClientResponse>(`${path}/oauth2`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** The client, as the OAuth2 tab shows it; the secret only when this read made the client. */
export async function showOAuth(request: ConsoleRequest, handle: string) {
  const { response } = await read(request, handle);
  return present(handle, response);
}

export async function addRedirect(request: ConsoleRequest, handle: string, uri: string) {
  const { path, response } = await read(request, handle);
  const wanted = uri.trim();
  if (!wanted) throw new CliError("Name the redirect URL.", "usage");
  if (response.client.redirect_uris.includes(wanted)) return present(handle, response);
  return present(handle, await patch(request, path, { redirect_uris: [...response.client.redirect_uris, wanted] }));
}

export async function removeRedirect(request: ConsoleRequest, handle: string, uri: string) {
  const { path, response } = await read(request, handle);
  const wanted = uri.trim();
  if (!response.client.redirect_uris.includes(wanted)) {
    throw new CliError(`${wanted} is not one of this agent's redirects. Nothing was changed.`, "not_found");
  }
  return present(handle, await patch(request, path, { redirect_uris: response.client.redirect_uris.filter((item) => item !== wanted) }));
}

/** Sets the optional scopes; openid and profile are always on. */
export async function setScopes(request: ConsoleRequest, handle: string, scopes: string[]) {
  const unknown = scopes.filter((scope) => !(OAUTH_SCOPES as readonly string[]).includes(scope));
  if (unknown.length) throw new CliError(`Unknown scope ${unknown.join(", ")}. Scopes are ${OAUTH_SCOPES.join(", ")}.`, "usage");
  const { path } = await findAgent(request, handle);
  return present(handle, await patch(request, path, { scopes: ["openid", "profile", ...scopes] }));
}

/** Discord's Reset Secret: a new secret, shown once; the old one stops working. */
export async function resetSecret(request: ConsoleRequest, handle: string) {
  const { path } = await findAgent(request, handle);
  return present(handle, await request<OAuthClientResponse>(`${path}/oauth2/reset-secret`, { method: "POST" }));
}
