// Multi-account resolution: channels.relay.accounts.<id> with a
// default-account fallback, so one OpenClaw can back several Relay contacts
// (one Agent Token each). Env vars cover the single-account quickstart.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution-runtime";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_RELAY_BASE_URL, normalizeRelayBaseUrl } from "./client.js";
import type { RelayAccountConfig, RelayCoreConfig, ResolvedRelayAccount } from "./types.js";

export const RELAY_TOKEN_ENV_VAR = "RELAY_AGENT_TOKEN";
export const RELAY_BASE_URL_ENV_VAR = "RELAY_BASE_URL";

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("relay", {
  normalizeAccountId,
  implicitDefaultAccount: {
    channelKeys: ["token", "tokenFile"],
    envVars: [RELAY_TOKEN_ENV_VAR],
  },
});

export {
  listAccountIds as listRelayAccountIds,
  resolveDefaultAccountId as resolveDefaultRelayAccountId,
  DEFAULT_ACCOUNT_ID,
};

function resolveMergedRelayAccountConfig(
  cfg: RelayCoreConfig,
  accountId: string,
): RelayAccountConfig {
  return resolveMergedAccountConfig<RelayAccountConfig>({
    channelConfig: cfg.channels?.relay as RelayAccountConfig | undefined,
    accounts: cfg.channels?.relay?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

function resolveToken(params: {
  merged: RelayAccountConfig;
  accountId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const direct = params.merged.token?.trim();
  if (direct) {
    return direct;
  }
  const fromFile = params.merged.tokenFile
    ? tryReadSecretFileSync(params.merged.tokenFile, "relay tokenFile")?.trim()
    : undefined;
  if (fromFile) {
    return fromFile;
  }
  // Env token applies to the default account only, so named accounts cannot
  // silently share one token.
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    return params.env[RELAY_TOKEN_ENV_VAR]?.trim() ?? "";
  }
  return "";
}

export function resolveRelayAccount(params: {
  cfg: RelayCoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedRelayAccount {
  const env = params.env ?? process.env;
  const accountId = normalizeAccountId(params.accountId);
  const merged = resolveMergedRelayAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.relay?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const token = resolveToken({ merged, accountId, env });
  const baseUrl = normalizeRelayBaseUrl(
    merged.baseUrl?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? env[RELAY_BASE_URL_ENV_VAR]?.trim() : undefined) ||
      DEFAULT_RELAY_BASE_URL,
  );
  const pollTimeoutSeconds = Math.min(
    Math.max(merged.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS, 1),
    30,
  );
  return {
    accountId,
    enabled,
    configured: Boolean(token),
    ...(merged.name?.trim() ? { name: merged.name.trim() } : {}),
    token,
    baseUrl,
    pollTimeoutSeconds,
    config: merged,
  };
}
