import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import Relay from "@relaymessenger/sdk";
import {
  defaultAuthURL,
  defaultConsoleApiURL,
  defaultCreationApiURL,
  readConfig,
  writeConfig,
  validateOrganizationKey,
  type ConfigContext,
  type RelayConfig,
  type RelayConsoleSession,
  type RelayConsoleOAuthSession,
  type RelayConsoleOrganizationKey,
} from "./config.js";
import { type InteractivePrompts } from "./interactive.js";
import { CliError } from "./error-codes.js";
import { prepareAgentImage, type LocalAgentImage } from "./local-image.js";
import { uploadAgentImage, type AgentImageUploadResult } from "./agent-image-upload.js";
import { safeMetadata } from "./output.js";

/** RFC 8628 device grant, as Relay-Auth's device-authorization plugin names it. */
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_CLIENT_ID = "relay-cli";

/** Generate the UUIDv7 required by the Console create-agent idempotency key. */
const uuidv7 = (): string => {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index]! = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
  }
  bytes[6]! = (bytes[6]! & 0x0f) | 0x70;
  bytes[8]! = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** The device flow ends in a Relay-Auth session: the bearer plus the person it belongs to. */
interface DeviceToken {
  user: { id: string; email: string; name?: string };
  access_token: string;
  expires_at: number;
}

export interface ConsoleAuthDependencies {
  context: ConfigContext;
  apiURL?: string;
  fetch?: typeof globalThis.fetch;
  prompts?: InteractivePrompts;
  stderr?: (value: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  website?: string;
  nonInteractive?: boolean;
}

export interface ConsoleRequestDependencies {
  context: ConfigContext;
  apiURL?: string;
  fetch?: typeof globalThis.fetch;
}

const httpFetch = (deps: ConsoleAuthDependencies | ConsoleRequestDependencies): typeof globalThis.fetch =>
  deps.fetch ?? globalThis.fetch;

/** The Console's own name for a refused create whose handle is taken
 * (Relay-Console apps/api/src/error-copy.ts, HANDLE_TAKEN_CODE). */
export const HANDLE_TAKEN = "handle_taken";

/** A Console refusal, carrying its status and the Console's short code and
 * nothing else from the body: an upstream message can hold a token. */
export class ConsoleRefusal extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const json = async <T>(response: Response): Promise<T> => {
  if (response.status === 401) {
    throw new CliError("Your Relay Console sign-in expired.", "signin_expired");
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Relay Console returned HTTP ${response.status}.`); }
  if (!response.ok) {
    // Console errors are not a safe place to echo arbitrary response text:
    // an upstream error can contain a bearer or refresh token. Only a short
    // code in the Console's own vocabulary travels with the status.
    const code = typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" && /^[a-z_]{1,40}$/u.test(value.code)
      ? value.code : undefined;
    throw new ConsoleRefusal(`Relay Console returned HTTP ${response.status}.`, response.status, code);
  }
  return value as T;
};

const openBrowser = async (url: string): Promise<void> => {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
};

const saveSession = async (context: ConfigContext, session: RelayConsoleSession): Promise<void> => {
  const config = await readConfig(context);
  config.console = session;
  await writeConfig(config, context);
};

const authURL = (deps: ConsoleAuthDependencies | ConsoleRequestDependencies): string =>
  defaultAuthURL(deps.context.env ?? process.env);

const postDeviceStart = async (deps: ConsoleAuthDependencies): Promise<DeviceStart> => {
  const response = await httpFetch(deps)(`${authURL(deps)}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
  });
  return json<DeviceStart>(response);
};

/** The person the bearer belongs to, and when the session ends. */
const fetchSession = async (deps: ConsoleAuthDependencies, accessToken: string): Promise<DeviceToken> => {
  const response = await httpFetch(deps)(`${authURL(deps)}/api/auth/get-session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const value = await response.json().catch(() => null) as {
    user?: { id?: unknown; email?: unknown; name?: unknown };
    session?: { expiresAt?: unknown };
  } | null;
  if (!response.ok || typeof value?.user?.id !== "string" || typeof value.user.email !== "string") {
    throw new Error("Relay login did not return the signed-in person.");
  }
  const expiresAt = typeof value.session?.expiresAt === "string" ? Date.parse(value.session.expiresAt)
    : typeof value.session?.expiresAt === "number" ? value.session.expiresAt
      : Number.NaN;
  return {
    access_token: accessToken,
    // The session lasts 30 days; fall back to that when the date does not parse.
    expires_at: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 24 * 60 * 60 * 1000,
    user: {
      id: value.user.id,
      email: value.user.email,
      ...(typeof value.user.name === "string" && value.user.name ? { name: value.user.name } : {}),
    },
  };
};

const pollDevice = async (deps: ConsoleAuthDependencies, start: DeviceStart): Promise<DeviceToken> => {
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = Math.max(1, start.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const response = await httpFetch(deps)(`${authURL(deps)}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT,
        device_code: start.device_code,
        client_id: DEVICE_CLIENT_ID,
      }),
    });
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) {
      if (typeof value.access_token !== "string" || !value.access_token) {
        throw new Error("Relay login returned an incomplete response.");
      }
      return fetchSession(deps, value.access_token);
    }
    // Error codes per the device-authorization plugin: authorization_pending,
    // slow_down (+5 s), expired_token, access_denied, invalid_grant.
    const error = typeof value.error === "string" ? value.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { interval += 5_000; continue; }
    if (error === "access_denied") throw new CliError("Relay login was denied.", "refused");
    if (error === "expired_token") throw new CliError("Relay login expired. Run relay login again.", "refused");
    throw new Error(`Relay login failed (HTTP ${response.status}).`);
  }
  throw new CliError("Relay login expired. Run relay login again.", "refused");
};

/**
 * Relay Console names a person's first organization itself (Relay-Console
 * apps/api/src/routes/me.ts, firstOrganization): GET /me creates it on the
 * first call and answers 409 organization_selection_required when the person
 * belongs to several and has not chosen one. The 409 body carries no list, so
 * the choice is made in Console, not here.
 */
const readOrganization = async (deps: ConsoleAuthDependencies, token: DeviceToken): Promise<string> => {
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  const response = await httpFetch(deps)(`${api}/me`, {
    headers: { Authorization: `Bearer ${token.access_token}`, "X-Relay-CLI": "1" },
  });
  if (response.status === 409) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    if (value?.code === "organization_selection_required") {
      throw new CliError("Choose an organization in Relay Console, then run relay login again.", "refused");
    }
  }
  const value = await json<{ org?: { id?: unknown } }>(response);
  if (typeof value?.org?.id !== "string" || !value.org.id) throw new Error("Relay Console did not return an organization.");
  return value.org.id;
};

/** Ends the Relay-Auth session server-side; a failure is not fatal, the local copy is still removed. */
export const consoleSignOut = async (deps: ConsoleRequestDependencies): Promise<boolean> => {
  const session = (await readConfig(deps.context)).console;
  if (!session || session.type === "organization_key") return false;
  try {
    const response = await httpFetch(deps)(`${authURL(deps)}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const consoleLogin = async (deps: ConsoleAuthDependencies): Promise<RelayConsoleOAuthSession> => {
  const stderr = deps.stderr ?? ((value) => process.stderr.write(value));
  const start = await postDeviceStart(deps);
  const verification = start.verification_uri_complete ?? start.verification_uri;
  stderr(`Your code is ${start.user_code}\n`);
  stderr(`Open ${verification}\n`);
  stderr(`If it does not open, enter this code at ${start.verification_uri}: ${start.user_code}\n`);
  await (deps.openBrowser ?? openBrowser)(verification).catch(() => undefined);
  const token = await pollDevice(deps, start);
  const organizationId = await readOrganization(deps, token);
  const session: RelayConsoleOAuthSession = {
    access_token: token.access_token,
    expires_at: token.expires_at,
    organization_id: organizationId,
    user: token.user,
  };
  await saveSession(deps.context, session);
  if (deps.website !== undefined) {
    await consoleRequest(
      { context: deps.context, ...(deps.apiURL ? { apiURL: deps.apiURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) },
      `/orgs/${organizationId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website: deps.website }),
      },
    );
  }
  return session;
};

/** Validate the real key with Console before replacing any saved credentials. */
export const consoleLoginWithKey = async (
  deps: ConsoleRequestDependencies,
  raw: string,
): Promise<RelayConsoleOrganizationKey> => {
  const key = validateOrganizationKey(raw);
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  let me: { org: { id: string } };
  try {
    me = await json(await httpFetch(deps)(`${api}/me`, {
      headers: { Authorization: `Bearer ${key}`, "X-Relay-CLI": "1" },
    }));
    if (typeof me?.org?.id !== "string" || !me.org.id) throw new Error("Missing organization");
  } catch (error) {
    if (error instanceof CliError && error.code === "signin_expired") throw error;
    throw new Error("Relay Console could not validate this organization API key. Nothing was changed.");
  }
  const session: RelayConsoleOrganizationKey = {
    type: "organization_key",
    organization_key: key,
    organization_id: me.org.id,
    console_api_url: api,
  };
  await saveSession(deps.context, session);
  return session;
};

export const consoleLoginOrReuse = async (
  deps: ConsoleAuthDependencies,
): Promise<RelayConsoleSession> => {
  const current = (await readConfig(deps.context)).console;
  if (current?.organization_id) {
    try {
      await consoleRequest(
        { context: deps.context, ...(deps.apiURL ? { apiURL: deps.apiURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) },
        "/me",
      );
      const session = (await readConfig(deps.context)).console ?? current;
      if (deps.website !== undefined) {
        await consoleRequest(
          { context: deps.context, ...(deps.apiURL ? { apiURL: deps.apiURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) },
          `/orgs/${session.organization_id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ website: deps.website }),
          },
        );
      }
      return session;
    } catch (error) {
      // A key is an explicit headless credential, never a browser-login hint.
      if (current.type === "organization_key") throw error;
      // A stale or revoked session falls through to the browser flow.
    }
  }
  if (deps.nonInteractive) throw new CliError("Not signed in.", "no_token");
  return consoleLogin(deps);
};

export interface ConsoleAgentCreateInput {
  handle?: string;
  displayName?: string;
  subtitle?: string; description?: string;
  image?: string;
  imageRecipe?: import("@relaymessenger/sdk").AgentImageRecipe;
  cwd?: string;
  home?: string;
}

export interface ConsoleAgentCreateResult {
  agent: { handle: string; first_name: string; image_url: string | null };
  token: string;
  image?: AgentImageUploadResult;
}

/**
 * The handle derived from a name the person typed: the display name in
 * handle letters. Relay refuses a collision rather than renaming, so the handle
 * sent is the handle created (server console.ts, POST /agents).
 */
export const inventedHandle = (displayName: string): string =>
  displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/u, "").replace(/_+$/u, "").slice(0, 32).replace(/_+$/u, "") || "assistant";

/**
 * Handles are one flat namespace. The handles the CLI tries for a typed name: the
 * plain one, then one with 4 random lowercase letters or digits, then one with
 * 6, inside Relay's 32-character limit. A typed handle is tried once.
 */
const RANDOM_HANDLE_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomHandleSuffix = (length: number): string =>
  Array.from(randomBytes(length), (byte) => RANDOM_HANDLE_LETTERS[byte % RANDOM_HANDLE_LETTERS.length]!).join("");
export const inventedHandleAttempts = (base: string): string[] =>
  [base, ...[4, 6].map((length) => `${base.slice(0, 32 - length - 1)}_${randomHandleSuffix(length)}`)];

export const createConsoleAgent = async (
  deps: ConsoleRequestDependencies,
  input: ConsoleAgentCreateInput,
): Promise<ConsoleAgentCreateResult> => {
  let localImage: LocalAgentImage | undefined;
  let imageURL: string | undefined;
  if (input.image !== undefined) {
    const prepared = await prepareAgentImage(input.image, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.home ? { home: input.home } : {}),
    }).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)} No agent was created.`);
    });
    if (prepared.kind === "file") localImage = prepared.file;
    else imageURL = prepared.url;
  }
  if (input.imageRecipe !== undefined && imageURL === undefined && !localImage) {
    throw new Error("--image-recipe requires its rendered --image or --image-url.");
  }
  const me = await consoleRequest<{ org: { id: string } }>(deps, "/me");
  const attempts = input.handle === undefined && input.displayName !== undefined ? inventedHandleAttempts(inventedHandle(input.displayName)) : [input.handle];
  let response: { agent: { handle: string; displayName: string; avatarUrl: string | null }; token: string } | undefined;
  for (const [attempt, handle] of attempts.entries()) {
    try {
      response = await consoleRequest<NonNullable<typeof response>>(deps, `/orgs/${me.org.id}/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A new key per attempt: the refused one names an agent that does not exist.
          "Idempotency-Key": uuidv7(),
        },
        body: JSON.stringify({
          ...(handle === undefined ? {} : { handle }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
          ...(input.description === undefined ? {} : { description: input.description }),
        }),
      });
      break;
    } catch (error) {
      const taken = error instanceof ConsoleRefusal && error.status === 409 && error.code === HANDLE_TAKEN;
      if (!taken || attempt === attempts.length - 1) throw error;
    }
  }
  if (!response) throw new Error("Relay Console did not create the agent.");
  const created: ConsoleAgentCreateResult = {
    token: response.token,
    agent: {
      handle: response.agent.handle,
      first_name: response.agent.displayName,
      image_url: response.agent.avatarUrl,
    },
  };
  if (!imageURL && !localImage) return created;

  const client = new Relay({
    apiKey: created.token,
    baseURL: deps.apiURL ?? defaultCreationApiURL(),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  try {
    if (imageURL) {
      const agent = await client.contactCard.update({
        handle: created.agent.handle,
        image_url: imageURL,
        ...(input.imageRecipe ? { image_recipe: input.imageRecipe } : {}),
      }, { maxRetries: 0 });
      return { ...created, agent };
    }
    const outcome = await uploadAgentImage(
      { handle: created.agent.handle, ...(localImage ? { image: localImage } : {}) },
      client,
      (attachmentID) => client.contactCard.update({
        handle: created.agent.handle,
        attachment_id: attachmentID,
        ...(input.imageRecipe ? { image_recipe: input.imageRecipe } : {}),
      }, { maxRetries: 0 }),
    );
    const image = safeMetadata(outcome, [created.token]);
    return image.status === "updated"
      ? { ...created, agent: image.agent, image }
      : { ...created, image };
  } catch {
    return {
      ...created,
      image: {
        status: "incomplete",
        phase: "agent",
        message: "The agent was created and its token was saved. The picture did not go through. Set the picture on this profile; do not create the agent again.",
      },
    };
  }
};

export const consoleRequest = async <T>(
  deps: ConsoleRequestDependencies,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const config = await readConfig(deps.context);
  const session = config.console;
  if (!session) throw new CliError("Relay Console is not signed in. Run relay login.", "not_a_tty");
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  if (session.type === "organization_key") {
    if (api !== session.console_api_url) {
      throw new Error("This organization API key was saved for a different Console. Run relay login --with-token for this Console.");
    }
    try {
      const response = await httpFetch(deps)(`${api}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${session.organization_key}`,
          "X-Relay-CLI": "1",
        },
      });
      return safeMetadata(await json<T>(response), [session.organization_key]);
    } catch (error) {
      // Even network errors can contain the request's Authorization header.
      const message = safeMetadata(
        error instanceof Error ? error.message : "Relay Console request failed.",
        [session.organization_key],
      );
      if (error instanceof CliError) throw new CliError(message, error.code);
      if (error instanceof ConsoleRefusal) throw new ConsoleRefusal(message, error.status, error.code);
      throw new Error(message);
    }
  }
  // No refresh: a Relay-Auth session token lives 30 days and relay login renews it.
  if (session.expires_at <= Date.now()) {
    throw new CliError("Your Relay Console sign-in expired.", "signin_expired");
  }
  const response = await httpFetch(deps)(`${api}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
      "X-Relay-CLI": "1",
    },
  });
  return json<T>(response);
};

/** Console owns organization Agents; the SDK delete route owns developer Agents. */
export const deleteConsoleAgent = async (
  deps: ConsoleRequestDependencies,
  handle: string,
  agentToken: string,
): Promise<boolean> => {
  if (!(await readConfig(deps.context)).console) return false;
  const me = await consoleRequest<{ org: { id: string } }>(deps, "/me");
  const path = `/orgs/${encodeURIComponent(me.org.id)}/agents`;
  const agents = await consoleRequest<Array<{ id: string; handle: string }>>(deps, path);
  const agent = agents.find((entry) => entry.handle === handle);
  if (!agent) return false;
  // Explicit --profile must not delete one Agent and clear another's token.
  const client = new Relay({
    apiKey: agentToken,
    baseURL: deps.apiURL ?? defaultCreationApiURL(),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const cards = await client.contactCard.retrieve();
  if (!cards.contact_cards.some((card) => card.handle === handle && card.kind === "agent")) {
    throw new Error("The selected profile belongs to another agent. Nothing was deleted.");
  }
  await consoleRequest(deps, `${path}/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
  return true;
};
