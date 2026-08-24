/**
 * `relaymessenger pair` — device-code pairing.
 * POST /v1/pairings → terminal QR of the claim url + short code → long-poll
 * GET /v1/pairings/:id?wait=true until the phone claims it → store the
 * agent_token in ~/.relaymessenger/config.json (chmod 600), then pin the owner from
 * GET /v1/agents/me. Claimed status may recoverably re-return the token until
 * the first successful Agent API use (or the server's claim grace expires),
 * but the locally saved token is authoritative for interrupted finalization.
 */
import { hostname } from "node:os";
import qrcode from "qrcode-terminal";
import { RelayApiError, RelayClient, type PairingStatus } from "./api.js";
import { ConfigStore, type RelayConfig } from "./store.js";

export interface PairOptions {
  origin: string;
  engine?: string;
  deviceName?: string;
  config?: ConfigStore;
  client?: RelayClient;
  /** Injected for tests: builds the agent-authenticated client after claim. */
  agentClientFor?: (agentToken: string) => RelayClient;
  out?: (line: string) => void;
  renderQr?: (url: string) => void;
}

/**
 * The live API nests the profile: GET /v1/agents/me → { agent: { owner_user_id } }.
 * A bare top-level owner_user_id is accepted too for forward/backward tolerance.
 */
export function ownerUserIdFromMe(me: Record<string, unknown>): string | undefined {
  const agent = me.agent;
  if (typeof agent === "object" && agent !== null) {
    const nested = (agent as Record<string, unknown>).owner_user_id;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  const flat = me.owner_user_id;
  return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

function agentProfileFromMe(me: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof me.agent === "object" && me.agent !== null
    ? me.agent as Record<string, unknown>
    : undefined;
}

/**
 * Matches Relay-iOS's `Contact.profileShareURL` exactly: relayapp.im is the
 * only host `RelayAgentShareLink` accepts on the phone, regardless of
 * whatever RELAY_API_ORIGIN this CLI was paired against.
 */
export function profileUrlForHandle(handle: string): string {
  return `https://relayapp.im/@${handle}`;
}

/**
 * The print is never gated on visibility (the owner's own phone scanning it
 * is the primary use, which works at every level). The caption exists only
 * to explain a RESTRICTION the reader wouldn't otherwise know about — so
 * "public" gets none, same as a field the server didn't send at all: there
 * is nothing non-obvious to disclose about a link that already works for
 * anyone. Relay-Console has no copy for this concept: its "Unlisted" badge
 * is AgentStatus (Store listing status), a different enum from this one
 * (contactAccessPolicies.visibility), so reusing that word would be two
 * concepts sharing one label. Measured against Relay-Server:
 *   - "public" and "unlisted" both resolve at GET /v1/contacts/:handle/profile
 *     (server/src/routes/contacts.ts:1383-1455) with no session required —
 *     anyone holding the link can open it. "unlisted" additionally stays out
 *     of Store browse/search (server/src/domain/agentCreation.ts:188-191,
 *     the default for every pairing-created agent) — that's the one fact
 *     worth telling the owner, since it isn't visible from the link itself.
 *   - "private" 404s from that same route, indistinguishable from a
 *     handle that does not exist (contacts.ts:1441-1442); the signed-in
 *     counterpart at GET /v1/contacts/:handle (contacts.ts:319-336) only
 *     admits the owner (`or(ne(visibility, "private"), eq(ownerUserId, user.id))`).
 *     So "only you" is literal, not assumed.
 */
export function profileCaptionForVisibility(visibility: unknown): string | undefined {
  if (visibility === "unlisted") {
    return "Unlisted — anyone with the link can open this profile, but it won't turn up in search.";
  }
  if (visibility === "private") {
    return "Private — only you can open this; the link won't work for anyone else.";
  }
  return undefined;
}

async function finalizeSavedPairing(
  saved: RelayConfig,
  config: ConfigStore,
  agentClientFor: PairOptions["agentClientFor"],
  out: (line: string) => void,
  renderQr: (url: string) => void,
): Promise<void> {
  const agentClient =
    agentClientFor?.(saved.agent_token) ??
    new RelayClient(saved.api_origin, saved.agent_token);
  let ownerUserId = process.env.RELAY_OWNER_USER_ID;
  let apiAgent: Record<string, unknown> | undefined;
  try {
    const me = await agentClient.getMe();
    apiAgent = agentProfileFromMe(me);
    ownerUserId ??= ownerUserIdFromMe(me);
  } catch (error) {
    if (error instanceof RelayApiError && error.status === 401) throw error;
    if (!ownerUserId) {
      throw new Error(
        `Agent Token is safely stored, but owner lookup failed (${error instanceof Error ? error.message : error}). ` +
          "Run `relaymessenger pair` again to resume owner pinning with this saved token; " +
          "it will not create or overwrite an agent.",
      );
    }
  }
  if (!ownerUserId) {
    throw new Error(
      "Agent Token is safely stored, but the server did not report owner_user_id and " +
        "RELAY_OWNER_USER_ID is not set. The bridge fails closed without a pinned owner. " +
        "Set RELAY_OWNER_USER_ID, then run `relaymessenger pair` again to finalize this saved token.",
    );
  }
  const agent = {
    ...(saved.agent ?? {}),
    ...(apiAgent ?? {}),
  } as RelayConfig["agent"];
  config.save({ ...saved, agent, owner_user_id: ownerUserId });
  out(`Owner pinned: ${ownerUserId}. Only this user can drive the bridge.`);

  // The agent's own profile — printed here because this is the first point
  // the CLI has a live, owner-pinned handle; there is no separate create or
  // deploy step to hook (agents are created at console.relayapp.im, not by
  // this CLI). Reuses the same renderQr the pairing QR above used.
  const handle = agent?.handle;
  if (handle) {
    const profileUrl = profileUrlForHandle(handle);
    out("");
    out("Your agent's profile — scan to open it in Relay, or share the link:");
    out("");
    renderQr(profileUrl);
    out("");
    out(`  ${profileUrl}`);
    out(`  @${handle}`);
    const caption = profileCaptionForVisibility(agent?.visibility);
    if (caption) out(`  ${caption}`);
  }

  out("Next: relaymessenger start --engine claude   (run `relaymessenger help` for every ACP preset)");
}

export async function pair(options: PairOptions): Promise<void> {
  const out = options.out ?? console.log;
  const config = options.config ?? new ConfigStore();
  const client = options.client ?? new RelayClient(options.origin);
  const deviceName = options.deviceName ?? hostname();
  const renderQr =
    options.renderQr ?? ((url: string) => qrcode.generate(url, { small: true }));

  const existing = config.load();
  if (
    existing?.agent_token &&
    !existing.owner_user_id &&
    existing.api_origin === client.origin
  ) {
    out("Resuming owner pinning for the Agent Token already stored on this machine.");
    try {
      await finalizeSavedPairing(existing, config, options.agentClientFor, out, renderQr);
      return;
    } catch (error) {
      if (!(error instanceof RelayApiError) || error.status !== 401) throw error;
      out("Saved Agent Token was rejected (401); starting a fresh pairing for this origin.");
    }
  }

  const pairing = await client.createPairing(deviceName, options.engine);

  out("");
  out("Scan with the Relay app, or open the link on your phone:");
  out("");
  renderQr(pairing.url);
  out("");
  out(`  ${pairing.url}`);
  out(`  Pairing code: ${pairing.code}`);
  out("");
  out(`Waiting for the phone to claim (expires in ${Math.round(pairing.expires_in / 60)} min)…`);

  const deadline = Date.now() + pairing.expires_in * 1000;
  let status: PairingStatus | undefined;
  while (Date.now() < deadline) {
    try {
      status = await client.waitPairing(pairing.pairing_id, pairing.poll_token);
    } catch (error) {
      if (error instanceof RelayApiError && error.status === 404) {
        throw new Error("Pairing expired before it was claimed. Run `relaymessenger pair` again.");
      }
      if (error instanceof RelayApiError && error.status === 410) {
        throw new Error(
          "This pairing claim can no longer return its token. If config.json contains an Agent " +
            "Token, re-run `relaymessenger pair` to finalize that saved token; otherwise start a new pairing.",
        );
      }
      // Transient (network blip, 5xx, timeout): keep waiting until expiry.
      out(`(retrying: ${error instanceof Error ? error.message : error})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (status.status === "claimed") break;
  }
  if (!status || status.status !== "claimed") {
    throw new Error("Pairing expired before it was claimed. Run `relaymessenger pair` again.");
  }

  // Store the token before the first Agent API call. The server may re-return
  // it during its short claim-recovery window, while this durable local copy
  // lets a later `relaymessenger pair` resume without creating another agent.
  const saved: RelayConfig = {
    api_origin: client.origin,
    agent_token: status.agent_token,
    agent: status.agent as any,
    paired_at: new Date().toISOString(),
  };
  config.save(saved);
  out("");
  out(`Paired. Agent token stored in ${config.path} (mode 600).`);

  await finalizeSavedPairing(saved, config, options.agentClientFor, out, renderQr);
}
