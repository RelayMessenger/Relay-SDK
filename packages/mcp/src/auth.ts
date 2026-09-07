import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_API_URL = "https://api.relayapp.im";
export const DEFAULT_PROFILE = "default";

interface RelayProfile {
  api_url?: string;
  agent_token?: string;
}

interface RelayConfig {
  version: 1;
  current_profile: string;
  profiles: Record<string, RelayProfile>;
}

export interface AuthContext {
  env?: NodeJS.ProcessEnv;
  home?: string;
  profile?: string;
  apiURL?: string;
}

export interface ResolvedAgentAuth {
  profile: string;
  apiURL: string;
  token: string;
  source: "environment" | "profile";
  configPath: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const envFor = (context: AuthContext): NodeJS.ProcessEnv =>
  context.env ?? process.env;

export const relayConfigPath = (context: AuthContext = {}): string => {
  const env = envFor(context);
  if (env.RELAY_CONFIG_PATH) {
    if (!isAbsolute(env.RELAY_CONFIG_PATH)) {
      throw new Error("RELAY_CONFIG_PATH must be absolute.");
    }
    return env.RELAY_CONFIG_PATH;
  }
  const root = env.RELAY_CONFIG_DIR
    ?? env.XDG_CONFIG_HOME
    ?? join(context.home ?? homedir(), ".config");
  return resolve(root, "relay", "config.json");
};

const profileName = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
    throw new Error("Relay profile name is invalid.");
  }
  return value;
};

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost"
  || hostname === "127.0.0.1"
  || hostname === "::1"
  || hostname === "[::1]";

export const validateApiURL = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new Error("Relay API URL must be absolute.", { cause });
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Relay API URL must be an origin without credentials.");
  }
  if (
    url.protocol !== "https:"
    && !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error("Relay API URL must use HTTPS (HTTP is loopback-only).");
  }
  return url.origin;
};

const tokenValue = (input: string): string => {
  const token = input.trim();
  if (!token || /[\r\n\0]/.test(token)) {
    throw new Error("Relay Agent Token is empty or malformed.");
  }
  return token;
};

const readLocalConfig = async (
  context: AuthContext,
): Promise<RelayConfig | undefined> => {
  try {
    const parsed = JSON.parse(
      await readFile(relayConfigPath(context), "utf8"),
    ) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || typeof parsed.current_profile !== "string"
      || !isRecord(parsed.profiles)
    ) {
      throw new Error("Relay config has an unsupported format.");
    }
    const profiles: Record<string, RelayProfile> = {};
    for (const [name, raw] of Object.entries(parsed.profiles)) {
      profileName(name);
      if (!isRecord(raw)) throw new Error(`Relay profile ${name} is invalid.`);
      const apiURL = raw.api_url;
      const token = raw.agent_token;
      if (apiURL !== undefined && typeof apiURL !== "string") {
        throw new Error(`Relay profile ${name} has an invalid API URL.`);
      }
      if (token !== undefined && typeof token !== "string") {
        throw new Error(`Relay profile ${name} has an invalid Agent Token.`);
      }
      profiles[name] = {
        ...(apiURL === undefined ? {} : { api_url: validateApiURL(apiURL) }),
        ...(token === undefined ? {} : { agent_token: tokenValue(token) }),
      };
    }
    return {
      version: 1,
      current_profile: profileName(parsed.current_profile),
      profiles,
    };
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error("Relay config is not valid JSON.", { cause: error });
    }
    throw error;
  }
};

export const resolveAgentAuth = async (
  context: AuthContext = {},
): Promise<ResolvedAgentAuth> => {
  const env = envFor(context);
  const config = await readLocalConfig(context);
  const profile = profileName(
    context.profile
      ?? env.RELAY_PROFILE
      ?? config?.current_profile
      ?? DEFAULT_PROFILE,
  );
  const selected = config?.profiles[profile];
  if (config && !selected) throw new Error(`Relay profile ${profile} does not exist.`);
  const apiURL = validateApiURL(
    context.apiURL
      ?? env.RELAY_API_URL
      ?? selected?.api_url
      ?? DEFAULT_API_URL,
  );
  const environmentToken = env.RELAY_AGENT_TOKEN;
  const token = environmentToken ?? selected?.agent_token;
  if (!token) {
    throw new Error(
      `No Agent Token for Relay profile ${profile}. Configure @relaymessenger/cli or RELAY_AGENT_TOKEN.`,
    );
  }
  return {
    profile,
    apiURL,
    token: tokenValue(token),
    source: environmentToken === undefined ? "profile" : "environment",
    configPath: relayConfigPath(context),
  };
};

export const collectLocalTokens = async (
  context: AuthContext = {},
): Promise<string[]> => {
  const tokens: string[] = [];
  const environmentToken = envFor(context).RELAY_AGENT_TOKEN;
  if (environmentToken) tokens.push(environmentToken);
  try {
    const config = await readLocalConfig(context);
    for (const profile of Object.values(config?.profiles ?? {})) {
      if (profile.agent_token) tokens.push(profile.agent_token);
    }
  } catch {
    // A malformed config must not prevent environment-secret redaction.
  }
  return [...new Set(tokens)];
};
