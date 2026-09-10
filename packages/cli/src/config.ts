import { inspectPrivateFile, openPrivateTemp, preparePrivateDestination, removeTemp, verifyPrivateACL, writePrivateDestination, type PrivateFileReport } from "./private-file.js";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_API_URL = "https://api.relayapp.im";
export const DEFAULT_PROFILE = "default";
export const STAGING_API_URL = "https://api.staging.relayapp.im";
/** This package's own version as published (`X.Y.Z` or `X.Y.Z-staging.N`). */
export const packageVersion = (): string =>
  createRequire(import.meta.url)("../package.json").version;
/** A `-staging` prerelease build targets the staging environment by itself. */
export const isStagingBuild = (version: string): boolean =>
  /-staging(?:\.|$)/u.test(version);
export const defaultCreationApiURL = (
  version: string = packageVersion(),
): string => isStagingBuild(version) ? STAGING_API_URL : DEFAULT_API_URL;

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
    throw new Error("This Relay config file was written by a newer or older version of this tool. Move it aside and sign in again.");
  }
  if (
    typeof value.current_profile !== "string"
    || !isRecord(value.profiles)
  ) {
    throw new Error("This Relay config file is missing the list of profiles. Move it aside and sign in again.");
  }
  const profiles: Record<string, RelayProfile> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    validateProfileName(name);
    if (!isRecord(profile)) throw new Error(`Profile ${name} in the Relay config file is not readable. Move the file aside and sign in again.`);
    const apiURL = profile.api_url;
    const token = profile.agent_token;
    if (apiURL !== undefined && typeof apiURL !== "string") {
      throw new Error(`Profile ${name} has an API address that is not text. Fix it in the Relay config file, or sign in again.`);
    }
    if (token !== undefined && typeof token !== "string") {
      throw new Error(`Profile ${name} has a token that is not text. Fix it in the Relay config file, or sign in again.`);
    }
    profiles[name] = {
      ...(apiURL === undefined ? {} : { api_url: validateApiURL(apiURL) }),
      ...(token === undefined ? {} : { agent_token: validateToken(token) }),
    };
  }
  if (!profiles[value.current_profile]) {
    throw new Error("The Relay config file points at a profile it does not contain. Choose one with npx relaymessenger profiles use.");
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

const CONFIG_WHAT = "Relay config";
const writeConfigUnlocked = async (config: RelayConfig, context: ConfigContext = {}): Promise<void> => {
  const normalized = parseConfig(config);
  const destination = await preparePrivateDestination(configPath(context), CONFIG_WHAT, context.platform ?? process.platform);
  await writePrivateDestination(destination, ".config", `${JSON.stringify(normalized, null, 2)}\n`);
};

/** Probe private creation, writing, syncing, renaming and ACL inspection without
 * replacing any existing config. This is not a reservation or recovery journal. */
export const preflightConfigDestination = async (context: ConfigContext = {}): Promise<void> => {
  await withConfigLock(context, async () => {
    await readConfig(context);
    const destination = await preparePrivateDestination(configPath(context), CONFIG_WHAT, context.platform ?? process.platform);
    const temporary = await openPrivateTemp(destination, ".config");
    const renamed = `${temporary.path}.probe`;
    try {
      try { await temporary.handle.writeFile("Relay private config preflight\n", "utf8"); await temporary.handle.sync(); }
      finally { await temporary.handle.close(); }
      await rename(temporary.path, renamed);
      await verifyPrivateACL(renamed, destination);
    } finally { await removeTemp(temporary.path); await removeTemp(renamed); }
  });
};

// Same-directory, exclusive lock serializes profile read/modify/write transactions.
// Never remove another process's lock or infer that its owner has died.
const withConfigLock = async <T>(context: ConfigContext, action: () => Promise<T>): Promise<T> => {
  const directory = dirname(configPath(context));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${configPath(context)}.lock`;
  // Native ACL operations require subprocesses; keep concurrent writers bounded
  // without applying the POSIX fast-write deadline to Windows.
  const windows = (context.platform ?? process.platform) === "win32";
  const deadline = Date.now() + (windows ? 120_000 : 5_000);
  let permissionRetries = 0;
  let lock;
  for (;;) {
    try { lock = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      // Windows can refuse an exclusive open while a lock file is being deleted.
      // Retry briefly, and only here; never change or delete someone else's lock,
      // and never turn a lasting permission error into the long wait.
      const transientWindowsPermission = windows && error.code === "EPERM" && permissionRetries++ < 10;
      if (error.code !== "EEXIST" && !transientWindowsPermission) throw error;
      if (Date.now() >= deadline) throw new Error("Another Relay command is writing the config file. Wait for it to finish, then run this again. Nothing was changed.");
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
      throw new Error("Another Relay command changed the config file while this one was running. Nothing was changed. Run this command again.");
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
      "A profile name must be 1 to 64 characters, using only letters, numbers, underscores, dots and hyphens.",
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
    throw new Error("The Relay API address must be a full web address, for example https://api.relayapp.im", { cause });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The Relay API address must be just the host, with no user name, password, question mark or # part.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("The Relay API address must end at the host name, with nothing after it. Use https://api.relayapp.im, not https://api.relayapp.im/v1");
  }
  if (
    url.protocol !== "https:"
    && !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error("The Relay API address must start with https://. Only an address on this computer, such as http://localhost:8787, may start with http://");
  }
  return url.origin;
};

export const validateForwardURL = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new Error("The address for --forward-to must be a full web address, for example http://localhost:3000/events", { cause });
  }
  if (
    !isLoopback(url.hostname)
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
  ) {
    throw new Error("The address for --forward-to must be on this computer, such as http://localhost:3000, and must not contain a user name or password.");
  }
  return url.toString();
};

export const validateToken = (value: string): string => {
  const token = value.trim();
  if (!token || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error("That token is empty, or it contains characters a token cannot have.");
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
      `Profile ${profile} has no saved token. Run npx relaymessenger auth login --with-token to save one.`,
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

export const inspectConfigPermissions = (
  context: ConfigContext = {},
): Promise<PrivateFileReport> => inspectPrivateFile(configPath(context), context.platform ?? process.platform);

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
