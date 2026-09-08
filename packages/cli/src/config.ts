import { inspectWindowsAcl, privateWindowsAcl, protectWindowsPath } from "./runtime-connect/windows-acl.js";
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

interface ConfigDestination {
  path: string;
  directory: string;
  windows: boolean;
  existingACL?: string;
}

// Shared by preflight and the final write: no credential bytes are changed here.
const prepareConfigDestination = async (context: ConfigContext): Promise<ConfigDestination> => {
  const path = configPath(context);
  const directory = dirname(path);
  const windows = (context.platform ?? process.platform) === "win32";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Relay config directory must be a regular directory.");
  if ((directoryInfo.mode & 0o222) === 0) throw new Error("Relay config directory is not writable.");
  await access(directory, constants.W_OK);
  if (!windows) await chmod(directory, 0o700);
  else if (!privateWindowsAcl(await inspectWindowsAcl(directory), true)) {
    throw new Error("Relay config directory is not owner-controlled; its permissions were not changed.");
  }
  let existingACL: string | undefined;
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error("Relay config must be a regular unlinked file.");
    if (!windows && (existing.mode & 0o077) !== 0) throw new Error("Existing Relay config permissions are not private.");
    if ((existing.mode & 0o444) === 0) throw new Error("Relay config is not readable.");
    if ((existing.mode & 0o222) === 0) throw new Error("Relay config is not writable.");
    // r+ verifies current OS read/write access without truncating or writing.
    const probe = await open(path, "r+"); await probe.close();
    if (windows) {
      const acl = await inspectWindowsAcl(path);
      if (!privateWindowsAcl(acl)) throw new Error("Existing Relay config ACL is not private; correct its permissions before replacing credentials.");
      existingACL = acl.sddl;
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return { path, directory, windows, ...(existingACL === undefined ? {} : { existingACL }) };
};

const privateConfigTemp = async (destination: ConfigDestination): Promise<{ path: string; handle: FileHandle }> => {
  const path = join(destination.directory, `.config.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(path, "wx", 0o600);
  try {
    if (destination.windows) {
      const acl = await protectWindowsPath(path, false, destination.existingACL);
      if (!privateWindowsAcl(acl) || (destination.existingACL !== undefined && acl.sddl !== destination.existingACL)) {
        throw new Error("Could not establish the private Relay config ACL before writing credentials.");
      }
    } else await handle.chmod(0o600);
    return { path, handle };
  } catch (error) {
    await handle.close(); await unlink(path); throw error;
  }
};
const verifyConfigACL = async (path: string, destination: ConfigDestination): Promise<void> => {
  if (!destination.windows) return;
  const acl = await inspectWindowsAcl(path);
  if (!privateWindowsAcl(acl) || (destination.existingACL !== undefined && acl.sddl !== destination.existingACL)) {
    throw new Error("Relay config was written but its final private ACL could not be verified.");
  }
};
const removeTemp = async (path: string): Promise<void> => {
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
};
const writeConfigUnlocked = async (config: RelayConfig, context: ConfigContext = {}): Promise<void> => {
  const normalized = parseConfig(config);
  const destination = await prepareConfigDestination(context);
  const temporary = await privateConfigTemp(destination);
  try {
    try { await temporary.handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8"); await temporary.handle.sync(); }
    finally { await temporary.handle.close(); }
    await rename(temporary.path, destination.path);
    await verifyConfigACL(destination.path, destination);
  } finally { await removeTemp(temporary.path); }
};

/** Probe private creation, writing, syncing, renaming and ACL inspection without
 * replacing any existing config. This is not a reservation or recovery journal. */
export const preflightConfigDestination = async (context: ConfigContext = {}): Promise<void> => {
  await withConfigLock(context, async () => {
    await readConfig(context);
    const destination = await prepareConfigDestination(context);
    const temporary = await privateConfigTemp(destination);
    const renamed = `${temporary.path}.probe`;
    try {
      try { await temporary.handle.writeFile("Relay private config preflight\n", "utf8"); await temporary.handle.sync(); }
      finally { await temporary.handle.close(); }
      await rename(temporary.path, renamed);
      await verifyConfigACL(renamed, destination);
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
      // Windows can deny an exclusive open during lock-file deletion. Retry
      // only this acquisition, briefly; never chmod/unlink someone else's lock
      // or turn a persistent permission error into the long busy timeout.
      const transientWindowsPermission = windows && error.code === "EPERM" && permissionRetries++ < 10;
      if (error.code !== "EEXIST" && !transientWindowsPermission) throw error;
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
): Promise<{ exists: boolean; secure: boolean; mode?: number; aclChecked?: boolean }> => {
  try {
    const info = await stat(configPath(context));
    const mode = info.mode & 0o777;
    if ((context.platform ?? process.platform) === "win32") {
      try {
        const path = configPath(context);
        const file = await lstat(path);
        const parent = await lstat(dirname(path));
        const acl = await inspectWindowsAcl(path);
        const parentACL = await inspectWindowsAcl(dirname(path));
        return { exists: true, secure: file.isFile() && !file.isSymbolicLink() && file.nlink === 1
          && parent.isDirectory() && !parent.isSymbolicLink()
          && privateWindowsAcl(acl) && privateWindowsAcl(parentACL, true), mode, aclChecked: true };
      } catch {
        return { exists: true, secure: false, mode, aclChecked: false };
      }
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
