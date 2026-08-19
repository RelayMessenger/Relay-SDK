import type { RelayAgentProfile } from "./types.js";

function normalizeSenderId(value: string | number): string | null {
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

/**
 * Build the only identities allowed to start an OpenClaw turn. The Relay
 * account owner is pinned from the authenticated agent profile; operators can
 * deliberately extend that set with `allowFrom`. No wildcard is accepted.
 */
export function resolveRelayAllowedSenderIds(params: {
  profile: Pick<RelayAgentProfile, "owner_user_id">;
  allowFrom?: Array<string | number>;
}): string[] {
  const allowed = new Set<string>();
  const owner = params.profile.owner_user_id?.trim();
  if (owner) {
    allowed.add(owner);
  }
  for (const entry of params.allowFrom ?? []) {
    const normalized = normalizeSenderId(entry);
    if (normalized && normalized !== "*") {
      allowed.add(normalized);
    }
  }
  return [...allowed];
}

export function relaySenderIsAllowed(
  allowedSenderIds: readonly string[],
  senderId: string,
): boolean {
  return allowedSenderIds.includes(senderId);
}
