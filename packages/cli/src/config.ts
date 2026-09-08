import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_API_URL = "https://api.relayapp.im";
export const DEFAULT_PROFILE = "default";
export const STAGING_API_URL = "https://api.staging.relayapp.im";
export const defaultCreationApiURL = (
  version: string = createRequire(import.meta.url)("../package.json").version,
): string => /-staging(?:\.|$)/u.test(version) ? STAGING_API_URL : DEFAULT_API_URL;

export interface RelayProfile {
  api_url?: string;
  agent_token?: string;
}

export interface RelayConfig {
  version: 1;
  current_profile: string;
  profiles: Record<string, RelayProfile>;
}

export interface ConfigContext {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedAuth {
  profile: string;
  apiURL: string;
  token: string;
  tokenSource: "environment" | "profile";
  configPath: string;
}

const contextEnv = (context: ConfigContext): NodeJS.ProcessEnv =>
  context.env ?? process.env;

export const configPath = (context: ConfigContext = {}): string => {
  const env = contextEnv(context);
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

export const emptyConfig = (): RelayConfig => ({
  version: 1,
  current_profile: DEFAULT_PROFILE,
  profiles: {
    [DEFAULT_PROFILE]: { api_url: DEFAULT_API_URL },
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseConfig = (value: unknown): RelayConfig => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Relay config has an unsupported format.");
  }
  if (
    typeof value.current_profile !== "string"
    || !isRecord(value.profiles)
  ) {
    throw new Error("Relay config is invalid.");
  }
  const profiles: Record<string, RelayProfile> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    validateProfileName(name);
    if (!isRecord(profile)) throw new Error(`Relay profile ${name} is invalid.`);
    const apiURL = profile.api_url;
    const token = profile.agent_token;
    if (apiURL !== undefined && typeof apiURL !== "string") {
      throw new Error(`Relay profile ${name} has an invalid API URL.`);
    }
    if (token !== undefined && typeof token !== "string") {
      throw new Error(`Relay profile ${name} has an invalid Agent Token.`);
    }
    profiles[name] = {
      ...(apiURL === undefined ? {} : { api_url: validateApiURL(apiURL) }),
      ...(token === undefined ? {} : { agent_token: validateToken(token) }),
    };
  }
  if (!profiles[value.current_profile]) {
    throw new Error("Relay config selects a missing profile.");
  }
  return {
    version: 1,
    current_profile: value.current_profile,
    profiles,
  };
};

const revisions = new WeakMap<RelayConfig, string>();
const rememberConfig = (config: RelayConfig): RelayConfig => {
  revisions.set(config, JSON.stringify(config));
  return config;
};

export const readConfig = async (
  context: ConfigContext = {},
): Promise<RelayConfig> => {
  try {
    const raw = await readFile(configPath(context), "utf8");
    return rememberConfig(parseConfig(JSON.parse(raw) as unknown));
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return rememberConfig(emptyConfig());
    }
    if (error instanceof SyntaxError) {
      throw new Error("Relay config is not valid JSON.", { cause: error });
    }
    throw error;
  }
};

const writeConfigUnlocked = async (
  config: RelayConfig,
  context: ConfigContext = {},
): Promise<void> => {
  const path = configPath(context);
  const directory = dirname(path);
  const normalized = parseConfig(config);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((context.platform ?? process.platform) !== "win32") {
    await chmod(directory, 0o700);
  }
  const temporary = join(
    directory,
    `.config.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

// Same-directory, exclusive lock serializes profile read/modify/write transactions.
// Never remove another process's lock or infer that its owner has died.
const withConfigLock = async <T>(context: ConfigContext, action: () => Promise<T>): Promise<T> => {
  const directory = dirname(configPath(context));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${configPath(context)}.lock`;
  const deadline = Date.now() + 5_000;
  let lock;
  for (;;) {
    try { lock = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Relay configuration is busy; no local change was made.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
};

export const writeConfig = async (config: RelayConfig, context: ConfigContext = {}): Promise<void> =>
  withConfigLock(context, async () => {
    const expected = revisions.get(config);
    if (expected !== undefined && JSON.stringify(await readConfig(context)) !== expected) {
      throw new Error("Relay configuration changed concurrently; no local change was made. Try the command again.");
    }
    await writeConfigUnlocked(config, context);
    rememberConfig(config);
  });

export const mutateConfig = async <T>(
  change: (config: RelayConfig) => T,
  context: ConfigContext = {},
): Promise<T> => withConfigLock(context, async () => {
  const config = await readConfig(context);
  const before = JSON.stringify(config);
  const result = change(config);
  if (JSON.stringify(config) !== before) await writeConfigUnlocked(config, context);
  return result;
});

export const validateProfileName = (name: string): string => {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name)) {
    throw new Error(
      "Profile names must be 1-64 letters, numbers, underscores, dots, or hyphens.",
    );
  }
  return name;
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
    throw new Error("Relay API URL must be an absolute URL.", { cause });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Relay API URL cannot contain credentials, query, or hash.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Relay API URL must be an origin without a path.");
  }
  if (
    url.protocol !== "https:"
    && !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error("Relay API URL must use HTTPS (HTTP is loopback-only).");
  }
  return url.origin;
};

export const validateForwardURL = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new Error("Forward URL must be absolute.", { cause });
  }
  if (
    !isLoopback(url.hostname)
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
  ) {
    throw new Error("Forward URL must be loopback HTTP(S) without credentials.");
  }
  return url.toString();
};

export const validateToken = (value: string): string => {
  const token = value.trim();
  if (!token || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error("Agent Token is empty or malformed.");
  }
  return token;
};

export const resolveAuth = async (
  requestedProfile?: string,
  context: ConfigContext = {},
): Promise<ResolvedAuth> => {
  const env = contextEnv(context);
  const config = await readConfig(context);
  const profile = validateProfileName(
    requestedProfile ?? env.RELAY_PROFILE ?? config.current_profile,
  );
  const selected = config.profiles[profile];
  if (!selected) throw new Error(`Relay profile ${profile} does not exist.`);
  const apiURL = validateApiURL(
    env.RELAY_API_URL ?? selected.api_url ?? DEFAULT_API_URL,
  );
  const envToken = env.RELAY_AGENT_TOKEN;
  const token = envToken === undefined
    ? selected.agent_token
    : validateToken(envToken);
  if (!token) {
    throw new Error(
      `No Agent Token for profile ${profile}. Run relay auth login --with-token.`,
    );
  }
  return {
    profile,
    apiURL,
    token: validateToken(token),
    tokenSource: envToken === undefined ? "profile" : "environment",
    configPath: configPath(context),
  };
};

export const inspectConfigPermissions = async (
  context: ConfigContext = {},
): Promise<{ exists: boolean; secure: boolean; mode?: number }> => {
  try {
    const info = await stat(configPath(context));
    const mode = info.mode & 0o777;
    if ((context.platform ?? process.platform) === "win32") {
      return { exists: true, secure: true, mode };
    }
    return { exists: true, secure: (mode & 0o077) === 0, mode };
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return { exists: false, secure: true };
    }
    throw error;
  }
};

export const collectConfiguredTokens = async (
  context: ConfigContext = {},
): Promise<string[]> => {
  const config = await readConfig(context);
  const tokens = Object.values(config.profiles)
    .map((profile) => profile.agent_token)
    .filter((token): token is string => Boolean(token));
  const envToken = contextEnv(context).RELAY_AGENT_TOKEN;
  if (envToken) tokens.push(envToken);
  return [...new Set(tokens)];
};
