import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import Relay from "@relaymessenger/sdk";
import {
  defaultConsoleApiURL,
  defaultCreationApiURL,
  readConfig,
  writeConfig,
  type ConfigContext,
  type RelayConfig,
  type RelayConsoleSession,
} from "./config.js";
import { HeadlessPrompt, type InteractivePrompts } from "./interactive.js";
import { CliError } from "./error-codes.js";
import { prepareAgentImage, type LocalAgentImage } from "./local-image.js";
import { uploadAgentImage, type AgentImageUploadResult } from "./agent-image-upload.js";
import { safeMetadata } from "./output.js";

const WORKOS_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const WORKOS_TOKEN_URL = "https://api.workos.com/user_management/authenticate";

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
  client_id: string;
}

interface DeviceToken {
  user: { id: string; email: string; name?: string; first_name?: string; last_name?: string };
  organization_id?: string;
  access_token: string;
  refresh_token: string;
}

export interface ConsoleAuthDependencies {
  context: ConfigContext;
  apiURL?: string;
  fetch?: typeof globalThis.fetch;
  prompts?: InteractivePrompts;
  stderr?: (value: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  name?: string;
  namespace?: string;
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

const json = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Relay Console returned HTTP ${response.status}.`); }
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value && typeof value.error === "string"
      ? value.error : `Relay Console returned HTTP ${response.status}.`;
    throw new Error(message);
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

const userName = (user: DeviceToken["user"]): string => {
  if (user.name?.trim()) return user.name.trim();
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  return user.email.split("@", 1)[0] || "Personal";
};

const publicMailDomains = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com",
]);

/** WorkOS AuthKit returns the verified email; use a Workspace domain only as a display hint. */
export const organizationDefaults = (user: DeviceToken["user"]): { name: string; namespace: string } => {
  const emailDomain = user.email.split("@")[1]?.toLowerCase();
  const company = emailDomain && !publicMailDomains.has(emailDomain)
    ? emailDomain.split(".")[0]!.replace(/[-_]+/g, " ").trim()
    : "";
  const name = company ? company.replace(/\b\w/g, (value) => value.toUpperCase()) : userName(user);
  const namespace = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 63) || "personal";
  return { name: name.slice(0, 80), namespace };
};

const expiryFromAccessToken = (token: string): number => {
  try {
    const [, encoded] = token.split(".");
    if (encoded) {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof payload.exp === "number") return payload.exp * 1000;
    }
  } catch { /* Use a short conservative lifetime when the token shape changes. */ }
  return Date.now() + 15 * 60 * 1000;
};

const saveSession = async (context: ConfigContext, session: RelayConsoleSession): Promise<void> => {
  const config = await readConfig(context);
  config.console = session;
  await writeConfig(config, context);
};

const postDeviceStart = async (deps: ConsoleAuthDependencies): Promise<DeviceStart> => {
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  const response = await httpFetch(deps)(`${api}/auth/cli/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return json<DeviceStart>(response);
};

const pollDevice = async (deps: ConsoleAuthDependencies, start: DeviceStart): Promise<DeviceToken> => {
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = Math.max(1, start.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const body = new URLSearchParams({
      grant_type: WORKOS_DEVICE_GRANT,
      device_code: start.device_code,
    });
    const response = await httpFetch(deps)(`${api}/auth/cli/device-code`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) {
      if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string" || !value.user || typeof value.user !== "object") {
        throw new Error("Relay Console returned an incomplete login response.");
      }
      return value as unknown as DeviceToken;
    }
    const error = typeof value.error === "string" ? value.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { interval += 5_000; continue; }
    if (error === "access_denied") throw new CliError("Relay Console login was denied.", "refused");
    if (error === "expired_token") throw new CliError("Relay Console login expired. Run relay login again.", "refused");
    throw new Error(typeof value.error_description === "string" ? value.error_description : `Relay Console login failed (HTTP ${response.status}).`);
  }
  throw new CliError("Relay Console login expired. Run relay login again.", "refused");
};

const bootstrap = async (
  deps: ConsoleAuthDependencies,
  token: DeviceToken,
  setup: { name: string; namespace: string },
): Promise<string> => {
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  const response = await httpFetch(deps)(`${api}/auth/cli/bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "X-Relay-CLI": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: setup.name, handleNamespace: setup.namespace }),
  });
  const value = await json<{ organization_id?: string; error?: string }>(response);
  if (!value.organization_id) throw new Error("Relay Console did not return an organization.");
  return value.organization_id;
};

const refresh = async (deps: ConsoleRequestDependencies, session: RelayConsoleSession): Promise<RelayConsoleSession> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: session.client_id,
    refresh_token: session.refresh_token,
    ...(session.organization_id ? { organization_id: session.organization_id } : {}),
  });
  const response = await httpFetch(deps)(WORKOS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = await json<{ access_token: string; refresh_token?: string; organization_id?: string }>(response);
  return {
    ...session,
    access_token: value.access_token,
    refresh_token: value.refresh_token ?? session.refresh_token,
    expires_at: expiryFromAccessToken(value.access_token),
    ...(value.organization_id ? { organization_id: value.organization_id } : {}),
  };
};

export const consoleLogin = async (deps: ConsoleAuthDependencies): Promise<RelayConsoleSession> => {
  const stderr = deps.stderr ?? ((value) => process.stderr.write(value));
  const start = await postDeviceStart(deps);
  const verification = start.verification_uri_complete ?? start.verification_uri;
  stderr(`Open ${verification}\n`);
  if (start.user_code && !start.verification_uri_complete) stderr(`Code: ${start.user_code}\n`);
  await (deps.openBrowser ?? openBrowser)(verification).catch(() => undefined);
  const token = await pollDevice(deps, start);
  const defaults = organizationDefaults(token.user);
  let name = deps.name ?? defaults.name;
  let namespace = deps.namespace ?? defaults.namespace;
  if (!token.organization_id && deps.prompts && !deps.nonInteractive) {
    name = (await deps.prompts.text("Organization name", name)).trim() || name;
    namespace = (await deps.prompts.text("Namespace", namespace)).trim().toLowerCase() || namespace;
  } else if (!token.organization_id && deps.nonInteractive && (deps.name === undefined || deps.namespace === undefined)) {
    throw new HeadlessPrompt("Relay needs organization setup after login.", ["--organization-name <name>", "--namespace <namespace>"]);
  }
  const organizationId = await bootstrap(deps, token, { name, namespace });
  let session: RelayConsoleSession = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: expiryFromAccessToken(token.access_token),
    client_id: start.client_id,
    organization_id: organizationId,
    user: { id: token.user.id, email: token.user.email, ...(token.user.name ? { name: token.user.name } : {}) },
  };
  if (!token.organization_id) {
    session = await refresh(deps, session);
    session.organization_id = organizationId;
  }
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
      return (await readConfig(deps.context)).console ?? current;
    } catch {
      // A stale or revoked session falls through to the browser flow.
    }
  }
  return consoleLogin(deps);
};

export interface ConsoleAgentCreateInput {
  handle?: string;
  displayName: string;
  about?: string;
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
  const me = await consoleRequest<{ org: { id: string; handleNamespace: string } }>(deps, "/me");
  const base = (input.handle ?? (input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/u, "").replace(/_+$/u, "").slice(0, 32).replace(/_+$/u, "") || "assistant"));
  const handle = `${base}.${me.org.handleNamespace}`;
  const created = await consoleRequest<ConsoleAgentCreateResult>(deps, `/orgs/${me.org.id}/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": uuidv7(),
    },
    body: JSON.stringify({
      handle,
      displayName: input.displayName,
      isPremiumHandle: false,
      ...(input.about === undefined ? {} : { about: input.about }),
    }),
  });
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
  let session = config.console;
  if (!session) throw new CliError("Relay Console is not signed in. Run relay login.", "not_a_tty");
  if (session.expires_at <= Date.now() + 30_000) {
    session = await refresh(deps, session);
    await saveSession(deps.context, session);
  }
  const api = defaultConsoleApiURL(deps.apiURL ?? defaultCreationApiURL(), deps.context.env ?? process.env);
  const request = () => httpFetch(deps)(`${api}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${session!.access_token}`,
      "X-Relay-CLI": "1",
    },
  });
  let response = await request();
  if (response.status === 401) {
    session = await refresh(deps, session);
    await saveSession(deps.context, session);
    response = await request();
  }
  return json<T>(response);
};
