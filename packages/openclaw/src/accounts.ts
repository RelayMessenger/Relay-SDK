import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/account-id";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import type {
  RelayAccountConfig,
  RelayCoreConfig,
  ResolvedRelayAccount,
} from "./types.js";

export const RELAY_TOKEN_ENV_VAR = "RELAY_AGENT_TOKEN";
export const RELAY_BASE_URL_ENV_VAR = "RELAY_BASE_URL";
export const DEFAULT_RELAY_BASE_URL = "https://api.relayapp.im";

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers(
  "relay",
  {
    normalizeAccountId,
    implicitDefaultAccount: {
      channelKeys: ["token", "tokenFile"],
      envVars: [RELAY_TOKEN_ENV_VAR],
    },
  },
);

export {
  DEFAULT_ACCOUNT_ID,
  listAccountIds as listRelayAccountIds,
  resolveDefaultAccountId as resolveDefaultRelayAccountId,
};

function mergedAccountConfig(
  cfg: RelayCoreConfig,
  accountId: string,
): RelayAccountConfig {
  return resolveMergedAccountConfig<RelayAccountConfig>({
    channelConfig: cfg.channels?.relay,
    accounts: cfg.channels?.relay?.accounts,
    accountId,
    // A channel-level token or tokenFile belongs only to the implicit/default
    // account. Named accounts may inherit non-credential defaults, but must
    // opt into their own credential source.
    omitKeys:
      accountId === DEFAULT_ACCOUNT_ID
        ? ["defaultAccount"]
        : ["defaultAccount", "token", "tokenFile"],
    normalizeAccountId,
  });
}

function resolveToken(params: {
  config: RelayAccountConfig;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const inline = params.config.token?.trim();
  if (inline) return inline;

  const fromFile = params.config.tokenFile
    ? tryReadSecretFileSync(params.config.tokenFile, "relay tokenFile")?.trim()
    : undefined;
  if (fromFile) return fromFile;

  return params.accountId === DEFAULT_ACCOUNT_ID
    ? (params.env[RELAY_TOKEN_ENV_VAR]?.trim() ?? "")
    : "";
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

export function normalizeRelayBaseUrl(
  value: string | undefined,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value?.trim() || DEFAULT_RELAY_BASE_URL);
  } catch {
    throw new Error("relay: baseUrl must be an absolute Relay API origin");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("relay: baseUrl must not contain credentials, query, or fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("relay: baseUrl must be an origin without a path");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    throw new Error("relay: baseUrl must use HTTPS (HTTP is allowed only for loopback tests)");
  }
  return parsed.origin;
}

function normalizeAllowFrom(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

export function resolveRelayAccount(params: {
  cfg: RelayCoreConfig;
  accountId?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): ResolvedRelayAccount {
  const env = params.env ?? process.env;
  const accountId = normalizeAccountId(params.accountId);
  const config = mergedAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.relay?.enabled !== false;
  const token = resolveToken({ config, accountId, env });
  const configuredBaseUrl =
    config.baseUrl?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID
      ? env[RELAY_BASE_URL_ENV_VAR]?.trim()
      : undefined);
  return {
    accountId,
    ...(config.name?.trim() ? { name: config.name.trim() } : {}),
    enabled: baseEnabled && config.enabled !== false,
    configured: token.length > 0,
    token,
    baseUrl: normalizeRelayBaseUrl(configuredBaseUrl),
    allowFrom: normalizeAllowFrom(config.allowFrom),
    config,
  };
}
