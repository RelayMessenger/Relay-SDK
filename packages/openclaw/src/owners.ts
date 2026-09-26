/**
 * Whom the Relay channel answers.
 *
 * The owner ruled on 2026-09-25 that a connected agent answers only its owner
 * by default. OpenClaw's own channels never answer strangers by default either
 * (DM policy `pairing`; `open` "requires `allowFrom: ["*"]`", OpenClaw
 * docs/gateway/config-channels/shared-policies.md). Relay already knows the
 * owner, so the default is OpenClaw's `allowlist` policy holding the owners'
 * Contact IDs from `GET /v1/me` `owner_people`, the same IDs `relay connect`
 * writes as `--allow-from`. A configured `allowFrom` replaces the owners;
 * `allowFrom: ["*"]` answers everyone, OpenClaw's own spelling of `open`.
 */
export type RelaySenderPolicy = {
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
};

export function relaySenderPolicy(params: {
  allowFrom: readonly string[];
  owners: readonly string[];
}): RelaySenderPolicy {
  if (params.allowFrom.includes("*")) return { dmPolicy: "open", allowFrom: ["*"] };
  return {
    dmPolicy: "allowlist",
    allowFrom: [...(params.allowFrom.length > 0 ? params.allowFrom : params.owners)],
  };
}

/**
 * The owners' Contact IDs, read once when the account starts, only when
 * `allowFrom` is unset. A failed read stops the start (OpenClaw restarts the
 * channel), so the channel never falls back to answering everyone.
 */
export async function resolveRelayOwners(params: {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<string[]> {
  const response = await (params.fetch ?? globalThis.fetch)(
    `${params.baseUrl.replace(/\/+$/u, "")}/v1/me`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `relay: could not read this agent's owner (GET /v1/me returned HTTP ${response.status}); set channels.relay.allowFrom to choose whom it answers`,
    );
  }
  const body = (await response.json()) as { owner_people?: unknown };
  const people = Array.isArray(body.owner_people) ? body.owner_people : [];
  return people.flatMap((person) => {
    const id = (person as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? [id] : [];
  });
}
