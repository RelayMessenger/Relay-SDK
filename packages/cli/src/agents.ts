import { safeMetadata } from "./output.js";
import Relay, { RelayAPIError, type AgentCreateParams, type AgentImageRecipe, type ContactCardItem } from "@relaymessenger/sdk";
import type { ConfigContext, RelayConfig, ResolvedAuth } from "./config.js";
import { DEFAULT_API_URL, defaultCreationApiURL, mutateConfig, preflightConfigDestination, readConfig, resolveAuth, validateApiURL, validateProfileName, validateToken } from "./config.js";

/** Injected SDK and persistence boundaries keep command logic independently testable. */
export interface AgentDependencies {
  read: () => Promise<RelayConfig>;
  preflight: () => Promise<void>;
  update: <T>(change: (config: RelayConfig) => T) => Promise<T>;
  bootstrap: typeof Relay.createAgent;
  client: (token: string, apiURL: string) => Pick<Relay, "contactCard" | "agents">;
  auth: (profile?: string) => Promise<ResolvedAuth>;
  env: NodeJS.ProcessEnv;
}

export const agentDependencies = (context: ConfigContext = {}, fetch?: typeof globalThis.fetch): AgentDependencies => ({
  read: () => readConfig(context),
  preflight: () => preflightConfigDestination(context),
  update: (change) => mutateConfig(change, context),
  bootstrap: (body, options) => Relay.createAgent(body, { ...options, ...(fetch ? { fetch } : {}) }),
  client: (apiKey, baseURL) => new Relay({ apiKey, baseURL, ...(fetch ? { fetch } : {}) }),
  auth: (profile) => resolveAuth(profile, context),
  env: context.env ?? process.env,
});

/**
 * The developer-facing agent record. The API's ContactCardItem is the shape
 * every Relay contact shares (a person or an agent), so it carries `kind`,
 * `last_name` and `is_active`; a CLI record is always one active agent, so it
 * shows only what a developer uses: the Handle, the display name and the image.
 * Whitelisted fields only: never serialize an SDK response containing the secret.
 */
export interface AgentRecord { handle: string; display_name: string; image_url: string | null }
export const agentRecord = (card: ContactCardItem): AgentRecord => ({
  handle: card.handle, display_name: card.first_name, image_url: card.image_url,
});

export interface CreateAgentInput {
  profile?: string;
  apiURL?: string;
  tokenName?: string;
  handle?: string;
  firstName?: string;
  imageURL?: string;
  imageRecipe?: AgentImageRecipe;
}

// Status/code are safe structured diagnostics; server-controlled messages are not.
const apiFailure = (error: unknown): string => {
  if (!(error instanceof RelayAPIError)) return "";
  const status = Number.isInteger(error.status) ? ` HTTP ${error.status}.` : "";
  const code = Number.isInteger(error.code) ? ` Code ${error.code}.` : "";
  const retry = typeof error.retryAfter === "number" && Number.isFinite(error.retryAfter)
    ? ` Retry-After: ${error.retryAfter}s.` : "";
  return `${status}${code}${retry}`;
};

export async function createAgent(input: CreateAgentInput, deps: AgentDependencies) {
  const before = await deps.read();
  if (input.profile) {
    validateProfileName(input.profile);
    if (Object.hasOwn(before.profiles, input.profile)) throw new Error("Profile already exists; choose a new profile name.");
  }
  if (input.tokenName !== undefined && (input.tokenName.length < 1 || input.tokenName.length > 80 || /[\u0000-\u001f\u007f]/u.test(input.tokenName))) {
    throw new Error("Token name must be 1–80 characters without control characters.");
  }
  const apiURL = validateApiURL(input.apiURL ?? deps.env.RELAY_API_URL
    ?? defaultCreationApiURL());
  if (input.handle !== undefined && !/^[a-z][a-z0-9_]{2,31}\.dev$/u.test(input.handle)) {
    throw new Error("Handle must be a full lowercase .dev handle with a 3–32 character local part beginning with a letter.");
  }
  const firstName = input.firstName?.trim();
  if (firstName !== undefined && (!firstName || firstName.length > 255 || /[\u0000-\u001f\u007f]/u.test(firstName))) {
    throw new Error("Display name must be 1–255 characters without ASCII controls.");
  }
  if (input.imageURL !== undefined) {
    let image: URL;
    try { image = new URL(input.imageURL); } catch { throw new Error("Image URL must be publicly reachable HTTPS."); }
    if (image.protocol !== "https:" || image.username || image.password) throw new Error("Image URL must be HTTPS without URL credentials.");
  }
  if (input.imageRecipe !== undefined && input.imageURL === undefined) throw new Error("An image recipe requires its rendered --image-url; the CLI does not render images.");
  const picture = input.imageRecipe === undefined
    ? (input.imageURL === undefined ? {} : { image_url: input.imageURL })
    : { image_url: input.imageURL!, image_recipe: input.imageRecipe };
  const body: AgentCreateParams = {
    ...(input.tokenName === undefined ? {} : { token_name: input.tokenName }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(firstName === undefined ? {} : { first_name: firstName }),
    ...picture,
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 8192) throw new Error("Agent creation body exceeds 8192 bytes.");
  try { await deps.preflight(); } catch { throw new Error("Private credential storage preflight failed; no agent creation request was sent."); }
  let result;
  try {
    result = await deps.bootstrap(body, { baseURL: apiURL, maxRetries: 0 });
  } catch (error) {
    // The bootstrap error body may contain a secret not yet in our redaction set.
    const rejected = error instanceof RelayAPIError && error.status !== undefined
      && error.status >= 400 && error.status < 500;
    throw new Error(rejected
      ? `Agent creation was rejected.${apiFailure(error)} No automatic retry was made.`
      : `Agent creation was not confirmed.${apiFailure(error)} No automatic retry was made; the request may have created an identity.`);
  }
  try {
    const token = validateToken(result.secret);
    const profile = await deps.update((config) => {
      const base = validateProfileName(input.profile ?? result.agent.handle);
      let profile = base;
      if (input.profile && Object.hasOwn(config.profiles, profile)) throw new Error("Profile already exists.");
      for (let suffix = 2; Object.hasOwn(config.profiles, profile); suffix++) {
        profile = `${base.slice(0, 54)}-${suffix}`;
      }
      config.profiles[profile] = { api_url: apiURL, agent_token: token };
      return profile;
    });
    return safeMetadata({ profile, ...agentRecord(result.agent), share_url: result.share_url, api_url: apiURL, token: "stored" as const }, [token]);
  } catch {
    const rawHandle = typeof result.agent?.handle === "string" && /^[a-z][a-z0-9_]{2,31}\.dev$/u.test(result.agent.handle) ? result.agent.handle : "(unavailable)";
    const assigned = safeMetadata(rawHandle, typeof result.secret === "string" ? [result.secret] : []);
    let outcome = "local credential storage could not be verified";
    let present = false;
    try {
      const saved = await deps.read();
      present = typeof result.secret === "string" && Object.values(saved.profiles).some((profile) => profile.agent_token === result.secret && validateApiURL(profile.api_url ?? DEFAULT_API_URL) === apiURL);
      outcome = present ? "its credential is present in local config, but the write/security check failed" : "its credential could not be saved";
    } catch { /* The outcome remains explicitly unverified. */ }
    throw new Error(`Agent @${assigned} was created; ${outcome}. ${present ? "No retry was made. Check config permissions before continuing." : "No retry was made and no durable recovery mechanism is available."}`);
  }
}

export async function listAgents(deps: AgentDependencies) {
  const config = await deps.read();
  const agents = [];
  for (const [profile, saved] of Object.entries(config.profiles)) {
    const apiURL = validateApiURL(saved.api_url ?? DEFAULT_API_URL);
    if (!saved.agent_token) continue;
    try {
      // Deliberately not resolveAuth: ENV overrides must not impersonate every profile.
      const cards = await deps.client(saved.agent_token, apiURL).contactCard.retrieve();
      const own = cards.contact_cards.find((card) => card.kind === "agent" && card.is_active);
      if (!own) throw new Error("no active agent card");
      agents.push({ profile, ...agentRecord(own), api_url: apiURL, token: "stored" as const });
    } catch {
      agents.push({ profile, api_url: apiURL, token: "stored" as const, error: "Contact Card unavailable" });
    }
  }
  return safeMetadata({ agents }, [...Object.values(config.profiles).flatMap((saved) => saved.agent_token ? [saved.agent_token] : []), ...(deps.env.RELAY_AGENT_TOKEN ? [deps.env.RELAY_AGENT_TOKEN] : [])]);
}

export async function selectAgentAuth(handle: string, profile: string | undefined, deps: AgentDependencies): Promise<ResolvedAuth> {
  if (profile !== undefined || deps.env.RELAY_PROFILE !== undefined || deps.env.RELAY_AGENT_TOKEN !== undefined) {
    return deps.auth(profile);
  }
  const config = await deps.read();
  const requestedOrigin = deps.env.RELAY_API_URL === undefined ? undefined : validateApiURL(deps.env.RELAY_API_URL);
  const matches: Array<{ profile: string; token: string; apiURL: string }> = [];
  let unavailable = false;
  for (const [name, saved] of Object.entries(config.profiles)) {
    if (!saved.agent_token) continue;
    const apiURL = validateApiURL(saved.api_url ?? DEFAULT_API_URL);
    if (requestedOrigin !== undefined && apiURL !== requestedOrigin) continue;
    try {
      const cards = await deps.client(saved.agent_token, apiURL).contactCard.retrieve();
      if (cards.contact_cards.some((card) => card.handle === handle && card.kind === "agent")) matches.push({ profile: name, token: saved.agent_token, apiURL });
    } catch { unavailable = true; }
  }
  if (unavailable || matches.length !== 1) {
    throw new Error("Cannot select an unambiguous saved agent. Choose --profile explicitly; credentials were kept.");
  }
  const selected = matches[0]!;
  const auth = await deps.auth(selected.profile);
  if (auth.token !== selected.token || auth.apiURL !== selected.apiURL) {
    throw new Error("Selected profile changed during identification; no deletion was sent and credentials were kept.");
  }
  return auth;
}

export async function deleteAgent(handle: string, profile: string | undefined, deps: AgentDependencies) {
  const auth = await selectAgentAuth(handle, profile, deps);
  try {
    await deps.client(auth.token, auth.apiURL).agents.delete(handle, { maxRetries: 0 });
  } catch (error) {
    throw new Error(`Agent deletion was not confirmed; local credentials were kept.${apiFailure(error)}`);
  }
  let removed;
  try {
    removed = await deps.update((config) => {
      const saved = config.profiles[auth.profile];
      // A selected ENV token may be unrelated to the profile's saved credential.
      if (saved?.agent_token === auth.token && validateApiURL(saved.api_url ?? DEFAULT_API_URL) === auth.apiURL) {
        delete saved.agent_token;
        return true;
      }
      return false;
    });
  } catch {
    throw new Error("Agent deletion was confirmed, but local credential cleanup failed.");
  }
  return safeMetadata({ ok: true, handle, profile: auth.profile, token: removed ? "removed" : "unchanged" }, [auth.token]);
}
