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
  about?: string;
  imageURL?: string;
  imageRecipe?: AgentImageRecipe;
}

// Status/code are safe structured diagnostics; server-controlled messages are not.
const apiFailure = (error: unknown): string => {
  if (!(error instanceof RelayAPIError)) return "";
  const reference = [Number.isInteger(error.status) ? `error ${error.status}` : "", Number.isInteger(error.code) ? `code ${error.code}` : ""]
    .filter(Boolean).join(", ");
  const said = reference ? ` Relay said: ${reference}.` : "";
  const retry = typeof error.retryAfter === "number" && Number.isFinite(error.retryAfter)
    ? ` Try again in ${error.retryAfter} seconds.` : "";
  return `${said}${retry}`;
};

// Decision row 4: keep numeric API codes without exposing a bootstrap secret.
const safeAPIFailure = (message: string, error: unknown): Error => error instanceof RelayAPIError
  ? new RelayAPIError(message, {
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
  }) : new Error(message);

export async function createAgent(input: CreateAgentInput, deps: AgentDependencies) {
  const before = await deps.read();
  if (input.profile) {
    validateProfileName(input.profile);
    if (Object.hasOwn(before.profiles, input.profile)) throw new Error("Profile already exists; choose a new profile name.");
  }
  if (input.tokenName !== undefined && (input.tokenName.length < 1 || input.tokenName.length > 80 || /[\u0000-\u001f\u007f]/u.test(input.tokenName))) {
    throw new Error("The token name must be 1 to 80 characters, with no control characters.");
  }
  const apiURL = validateApiURL(input.apiURL ?? deps.env.RELAY_API_URL
    ?? defaultCreationApiURL());
  if (input.handle !== undefined && !/^[a-z][a-z0-9_]{2,31}\.dev$/u.test(input.handle)) {
    throw new Error("A handle looks like name.dev. The part before .dev must be 3 to 32 characters, start with a lowercase letter, and use only lowercase letters, numbers and underscores.");
  }
  const firstName = input.firstName?.trim();
  if (firstName !== undefined && (!firstName || firstName.length > 255 || /[\u0000-\u001f\u007f]/u.test(firstName))) {
    throw new Error("The name must be 1 to 255 characters, with no control characters.");
  }
  if (input.imageURL !== undefined) {
    let image: URL;
    try { image = new URL(input.imageURL); } catch { throw new Error("Image URL must start with https://"); }
    if (image.protocol !== "https:" || image.username || image.password) throw new Error("Image URL must start with https:// and must not contain a user name or password.");
  }
  if (input.imageRecipe !== undefined && input.imageURL === undefined) throw new Error("An image recipe also needs the finished picture. Pass --image or --image-url with it; this command does not draw pictures.");
  const picture = input.imageRecipe === undefined
    ? (input.imageURL === undefined ? {} : { image_url: input.imageURL })
    : { image_url: input.imageURL!, image_recipe: input.imageRecipe };
  const body: AgentCreateParams = {
    ...(input.about === undefined ? {} : { about: input.about.trim() }),
    ...(input.tokenName === undefined ? {} : { token_name: input.tokenName }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(firstName === undefined ? {} : { first_name: firstName }),
    ...picture,
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 8192) throw new Error("These agent details are too long. Shorten the name, the handle or the picture address.");
  try { await deps.preflight(); } catch { throw new Error("Relay could not prepare a private file to save the token in, so it did not create the agent. Check the permissions on your Relay config folder."); }
  let result;
  try {
    result = await deps.bootstrap(body, { baseURL: apiURL, maxRetries: 0 });
  } catch (error) {
    // The error body from Relay may hold a secret that is not yet in the redaction set.
    const rejected = error instanceof RelayAPIError && error.status !== undefined
      && error.status >= 400 && error.status < 500;
    const message = rejected
      ? `Relay refused to create this agent.${apiFailure(error)} Relay did not try again.`
      : `Relay did not answer, so this agent may or may not have been created.${apiFailure(error)} Relay did not try again. Run npx relaymessenger agents list to see what exists before you try once more.`;
    throw safeAPIFailure(message, error);
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
    let outcome = "Relay could not check whether its token was saved on this computer";
    let present = false;
    try {
      const saved = await deps.read();
      present = typeof result.secret === "string" && Object.values(saved.profiles).some((profile) => profile.agent_token === result.secret && validateApiURL(profile.api_url ?? DEFAULT_API_URL) === apiURL);
      outcome = present ? "its token is in your Relay config file, but Relay could not confirm the file is private" : "its token could not be saved";
    } catch { /* The outcome remains explicitly unverified. */ }
    throw new Error(`Agent @${assigned} was created, but ${outcome}. ${present ? "Relay did not try again. Check the permissions on your Relay config file before you continue." : "Relay did not try again, and it cannot get that token back. Delete this agent and create a new one."}`);
  }
}

export async function listAgents(deps: AgentDependencies) {
  const config = await deps.read();
  const agents = [];
  for (const [profile, saved] of Object.entries(config.profiles)) {
    const apiURL = validateApiURL(saved.api_url ?? DEFAULT_API_URL);
    if (!saved.agent_token) continue;
    try {
      // Deliberately not resolveAuth: a token in the environment must not stand in for every profile.
      const cards = await deps.client(saved.agent_token, apiURL).contactCard.retrieve();
      const own = cards.contact_cards.find((card) => card.kind === "agent" && card.is_active);
      if (!own) throw new Error("no active agent card");
      agents.push({ profile, ...agentRecord(own), api_url: apiURL, token: "stored" as const });
    } catch {
      agents.push({ profile, api_url: apiURL, token: "stored" as const, error: "Agent details unavailable" });
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
    throw new Error("More than one saved profile matches that handle, or one of them could not be read. Name the one you mean with --profile. Nothing was changed.");
  }
  const selected = matches[0]!;
  const auth = await deps.auth(selected.profile);
  if (auth.token !== selected.token || auth.apiURL !== selected.apiURL) {
    throw new Error("This profile changed while Relay was checking it. Nothing was deleted and your saved token is unchanged.");
  }
  return auth;
}

export async function deleteAgent(handle: string, profile: string | undefined, deps: AgentDependencies) {
  const auth = await selectAgentAuth(handle, profile, deps);
  try {
    await deps.client(auth.token, auth.apiURL).agents.delete(handle, { maxRetries: 0 });
  } catch (error) {
    throw safeAPIFailure(`Relay could not confirm this agent was deleted, so the token saved on this computer is unchanged.${apiFailure(error)}`, error);
  }
  let removed;
  try {
    removed = await deps.update((config) => {
      const saved = config.profiles[auth.profile];
      // A token from the environment may have nothing to do with the profile's saved token.
      if (saved?.agent_token === auth.token && validateApiURL(saved.api_url ?? DEFAULT_API_URL) === auth.apiURL) {
        delete saved.agent_token;
        return true;
      }
      return false;
    });
  } catch {
    throw new Error("The agent was deleted, but Relay could not remove its saved token from this computer. Remove it with npx relaymessenger auth logout.");
  }
  return safeMetadata({ ok: true, handle, profile: auth.profile, token: removed ? "removed" : "unchanged" }, [auth.token]);
}
