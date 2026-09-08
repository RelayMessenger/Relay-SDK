import Relay, { RelayAPIError, type AgentCreateParams, type ContactCardItem } from "@relaymessenger/sdk";
import type { ConfigContext, RelayConfig, ResolvedAuth } from "./config.js";
import { DEFAULT_API_URL, mutateConfig, readConfig, resolveAuth, validateApiURL, validateProfileName, validateToken } from "./config.js";

/** Injected SDK and persistence boundaries keep command logic independently testable. */
export interface AgentDependencies {
  read: () => Promise<RelayConfig>;
  update: <T>(change: (config: RelayConfig) => T) => Promise<T>;
  bootstrap: typeof Relay.createAgent;
  client: (token: string, apiURL: string) => Pick<Relay, "contactCard" | "agents">;
  auth: (profile?: string) => Promise<ResolvedAuth>;
  env: NodeJS.ProcessEnv;
}

export const agentDependencies = (context: ConfigContext = {}, fetch?: typeof globalThis.fetch): AgentDependencies => ({
  read: () => readConfig(context),
  update: (change) => mutateConfig(change, context),
  bootstrap: (body, options) => Relay.createAgent(body, { ...options, ...(fetch ? { fetch } : {}) }),
  client: (apiKey, baseURL) => new Relay({ apiKey, baseURL, ...(fetch ? { fetch } : {}) }),
  auth: (profile) => resolveAuth(profile, context),
  env: context.env ?? process.env,
});

// Whitelist output: never serialize an SDK response containing the one-time secret.
const cardMetadata = (card: ContactCardItem): ContactCardItem => ({
  handle: card.handle, first_name: card.first_name, last_name: card.last_name,
  image_url: card.image_url, is_active: card.is_active, kind: card.kind,
});

export interface CreateAgentInput {
  profile?: string;
  apiURL?: string;
  tokenName?: string;
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
    ?? before.profiles[before.current_profile]?.api_url ?? DEFAULT_API_URL);
  const body: AgentCreateParams = input.tokenName === undefined ? {} : { token_name: input.tokenName };
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
    return { profile, api_url: apiURL, agent: cardMetadata(result.agent), share_url: result.share_url, token: "stored" as const };
  } catch {
    throw new Error("Agent was created but its credential could not be saved. No retry was made. Check local configuration storage before creating another identity.");
  }
}

export async function listAgents(deps: AgentDependencies) {
  const config = await deps.read();
  const agents = [];
  for (const [profile, saved] of Object.entries(config.profiles)) {
    const apiURL = validateApiURL(saved.api_url ?? DEFAULT_API_URL);
    if (!saved.agent_token) {
      agents.push({ profile, api_url: apiURL, token: "missing" });
      continue;
    }
    try {
      // Deliberately not resolveAuth: ENV overrides must not impersonate every profile.
      const cards = await deps.client(saved.agent_token, apiURL).contactCard.retrieve();
      agents.push({ profile, api_url: apiURL, token: "stored", contact_cards: cards.contact_cards.map(cardMetadata) });
    } catch {
      agents.push({ profile, api_url: apiURL, token: "stored", error: "Contact Card unavailable" });
    }
  }
  return { agents };
}

export async function deleteAgent(handle: string, profile: string | undefined, deps: AgentDependencies) {
  const auth = await deps.auth(profile);
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
  return { ok: true, handle, profile: auth.profile, token: removed ? "removed" : "unchanged" };
}
