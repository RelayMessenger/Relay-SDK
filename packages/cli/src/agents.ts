import { describeFailure } from "./errors.js";
import { safeMetadata } from "./output.js";
import { createConsoleAgent, type ConsoleAgentCreateInput, type ConsoleAgentCreateResult } from "./console-auth.js";
import { savedAgentShareURL } from "./agent-session.js";
import { CliError } from "./error-codes.js";
import Relay, { RelayAPIError, type AgentImageRecipe, type ContactCardItem } from "@relaymessenger/sdk";
import type { ConfigContext, RelayConfig, ResolvedAuth } from "./config.js";
import { defaultCreationApiURL, mutateConfig, preflightConfigDestination, readConfig, resolveAuth, validateApiURL, validateProfileName, validateToken } from "./config.js";

/** Injected SDK and persistence boundaries keep command logic independently testable. */
export interface AgentDependencies {
  read: () => Promise<RelayConfig>;
  preflight: () => Promise<void>;
  update: <T>(change: (config: RelayConfig) => T) => Promise<T>;
  provision: (input: ConsoleAgentCreateInput, options: { apiURL: string }) => Promise<ConsoleAgentCreateResult>;
  client: (token: string, apiURL: string) => Pick<Relay, "contactCard" | "agents">;
  auth: (profile?: string) => Promise<ResolvedAuth>;
  deleteConsole?: (handle: string, apiURL: string, agentToken: string) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
}

export const agentDependencies = (context: ConfigContext = {}, fetch?: typeof globalThis.fetch): AgentDependencies => ({
  read: () => readConfig(context),
  preflight: () => preflightConfigDestination(context),
  update: (change) => mutateConfig(change, context),
  provision: (input, { apiURL }) => createConsoleAgent({ context, apiURL, ...(fetch ? { fetch } : {}) }, input),
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
export const agentRecord = (card: Pick<ContactCardItem, "handle" | "first_name" | "image_url">): AgentRecord => ({
  handle: card.handle, display_name: card.first_name, image_url: card.image_url,
});

export interface CreateAgentInput {
  profile?: string;
  apiURL?: string;
  handle?: string;
  firstName?: string;
  about?: string;
  imageURL?: string;
  imageRecipe?: AgentImageRecipe;
  /** Save the new profile as the last connected agent, in the same config write. */
  makeDefault?: boolean;
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
  }) : error instanceof CliError && error.code === "no_token"
    ? new CliError(message, "no_token") : new Error(message);

/** The handle a person asked for, checked before anything is created or asked. */
export const validateHandle = (handle: string): string => {
  if (!/^[a-z][a-z0-9_]{2,31}$/u.test(handle)) {
    throw new Error("A handle is one word using 3–32 lowercase letters, numbers, or underscores.");
  }
  return handle;
};

/** The name a person asked for, trimmed and checked the same way. */
export const validateFirstName = (name: string): string => {
  const firstName = name.trim();
  if (!firstName || firstName.length > 30 || /[\u0000-\u001f\u007f]/u.test(firstName)) {
    throw new Error("The name must be 1 to 30 characters, with no control characters.");
  }
  return firstName;
};

/** The name the CLI invents when the person gave none. */
export const DEFAULT_AGENT_NAME = "My Agent";

export async function createAgent(input: CreateAgentInput, deps: AgentDependencies) {
  const before = await deps.read();
  if (input.profile) {
    validateProfileName(input.profile);
    if (Object.hasOwn(before.profiles, input.profile)) throw new Error("Profile already exists; choose a new profile name.");
  }
  const apiURL = validateApiURL(input.apiURL ?? deps.env.RELAY_API_URL
    ?? defaultCreationApiURL());
  if (input.handle !== undefined) validateHandle(input.handle);
  const firstName = input.firstName === undefined ? undefined : validateFirstName(input.firstName);
  if (input.imageURL !== undefined) {
    let image: URL;
    try { image = new URL(input.imageURL); } catch { throw new Error("Image URL must start with https://"); }
    if (image.protocol !== "https:" || image.username || image.password) throw new Error("Image URL must start with https:// and must not contain a user name or password.");
  }
  if (input.imageRecipe !== undefined && input.imageURL === undefined) throw new Error("An image recipe also needs the finished picture. Pass --image or --image-url with it; this command does not draw pictures.");
  const body: ConsoleAgentCreateInput = {
    displayName: firstName ?? DEFAULT_AGENT_NAME,
    ...(input.about === undefined ? {} : { about: input.about.trim() }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 8192) throw new Error("These agent details are too long. Shorten the name, the handle or the picture address.");
  try { await deps.preflight(); } catch { throw new Error("Relay could not prepare a private file to save the token in, so it did not create the agent. Check the permissions on your Relay config folder."); }
  let result;
  try {
    result = await deps.provision(body, { apiURL });
  } catch (error) {
    // The error body from Relay may hold a secret that is not yet in the redaction set.
    const rejected = (error instanceof RelayAPIError && error.status !== undefined
      && error.status >= 400 && error.status < 500)
      || (error instanceof CliError && error.code === "no_token");
    const message = rejected
      ? `Relay refused to create this agent.${apiFailure(error)} Relay did not try again.`
      : `Relay did not confirm creation, so this agent may or may not have been created.${apiFailure(error)} Relay did not try again. Check your organization's agents in Relay Console before trying again.`;
    throw safeAPIFailure(message, error);
  }
  try {
    const token = validateToken(result.token);
    const profile = await deps.update((config) => {
      const base = validateProfileName(input.profile ?? result.agent.handle.slice(0, 64));
      let profile = base;
      if (input.profile && Object.hasOwn(config.profiles, profile)) throw new Error("Profile already exists.");
      for (let suffix = 2; Object.hasOwn(config.profiles, profile); suffix++) {
        profile = `${base.slice(0, 54)}-${suffix}`;
      }
      config.profiles[profile] = { api_url: apiURL, agent_token: token };
      if (input.makeDefault) config.defaultAgent = profile;
      return profile;
    });
    return safeMetadata({ profile, ...agentRecord(result.agent), share_url: savedAgentShareURL(apiURL, result.agent.handle), api_url: apiURL, token: "stored" as const }, [token]);
  } catch {
    const rawHandle = typeof result.agent?.handle === "string" && /^[a-z][a-z0-9_]{2,31}(?:\.[a-z0-9][a-z0-9_-]{1,62})?$/u.test(result.agent.handle) ? result.agent.handle : "(unavailable)";
    const assigned = safeMetadata(rawHandle, typeof result.token === "string" ? [result.token] : []);
    let outcome = "Relay could not check whether its token was saved on this computer";
    let present = false;
    try {
      const saved = await deps.read();
      present = typeof result.token === "string" && Object.values(saved.profiles).some((profile) => profile.agent_token === result.token && validateApiURL(profile.api_url ?? defaultCreationApiURL()) === apiURL);
      outcome = present ? "its token is in your Relay config file, but Relay could not confirm the file is private" : "its token could not be saved";
    } catch { /* The outcome remains explicitly unverified. */ }
    throw new Error(`Agent @${assigned} was created, but ${outcome}. ${present ? "Relay did not try again. Check the permissions on your Relay config file before you continue." : "Relay did not try again, and it cannot get that token back. Delete this agent and create a new one."}`);
  }
}

export async function listAgents(deps: AgentDependencies, onFailure?: (error: Error) => void) {
  const config = await deps.read();
  const agents = [];
  for (const [profile, saved] of Object.entries(config.profiles)) {
    const apiURL = validateApiURL(saved.api_url ?? defaultCreationApiURL());
    if (!saved.agent_token) continue;
    try {
      // Deliberately not resolveAuth: a token in the environment must not stand in for every profile.
      const cards = await deps.client(saved.agent_token, apiURL).contactCard.retrieve();
      const own = cards.contact_cards.find((card) => card.kind === "agent" && card.is_active);
      if (!own) throw new Error("no active agent card");
      agents.push({ profile, ...agentRecord(own), api_url: apiURL, token: "stored" as const });
    } catch (error) {
      const safeError = error instanceof TypeError && /fetch failed/iu.test(error.message)
        ? new TypeError("Agent details unavailable: fetch failed")
        : safeAPIFailure("Agent details unavailable", error);
      const { error: message, code, next_step } = describeFailure(safeError);
      agents.push({ profile, api_url: apiURL, token: "stored" as const, error: message, code, next_step });
      onFailure?.(safeError);
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
    const apiURL = validateApiURL(saved.api_url ?? defaultCreationApiURL());
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
    if (!await deps.deleteConsole?.(handle, auth.apiURL, auth.token)) {
      await deps.client(auth.token, auth.apiURL).agents.delete(handle, { maxRetries: 0 });
    }
  } catch (error) {
    throw safeAPIFailure(`Relay could not confirm this agent was deleted, so the token saved on this computer is unchanged.${apiFailure(error)}`, error);
  }
  let removed;
  try {
    removed = await deps.update((config) => {
      const saved = config.profiles[auth.profile];
      // A token from the environment may have nothing to do with the profile's saved token.
      if (saved?.agent_token === auth.token && validateApiURL(saved.api_url ?? defaultCreationApiURL()) === auth.apiURL) {
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
