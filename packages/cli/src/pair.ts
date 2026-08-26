/**
 * `relaymessenger pair` — Better Auth device authorization (RFC 8628).
 * POST /api/auth/device/code → terminal QR of the verification url + the short
 * user code → poll POST /api/auth/device/token until the person approves it in
 * the Relay app → use the returned session to POST /v1/me/agents, which creates
 * this machine's agent and issues its rly_live_ API key. The key is stored in
 * ~/.relaymessenger/config.json (chmod 600) before the first Agent API call,
 * then the owner is pinned from GET /v1/agents/me. The locally saved key is
 * authoritative for interrupted finalization: re-running the command resumes
 * owner pinning instead of creating a second agent.
 */
import { hostname } from "node:os";
import qrcode from "qrcode-terminal";
import {
  RelayApiError,
  RelayClient,
  type DeviceCodeGrant,
  type NewAgentBody,
} from "./api.js";
import { ConfigStore, type RelayConfig } from "./store.js";

/**
 * Identifies the CLI to the device-authorization endpoint. Relay does not
 * gate on registered clients, so this is a label in the approval screen and
 * the audit trail rather than a credential.
 */
export const DEVICE_CLIENT_ID = "relaymessenger-cli";

export interface PairOptions {
  origin: string;
  /** Display name for the created agent. Defaults to this machine's hostname. */
  deviceName?: string;
  /** Overrides the handle derived from the device name. */
  handle?: string;
  config?: ConfigStore;
  client?: RelayClient;
  /** Injected for tests: builds the agent-authenticated client after creation. */
  agentClientFor?: (agentToken: string) => RelayClient;
  out?: (line: string) => void;
  renderQr?: (url: string) => void;
  /** Injected for tests: the poll clock, delay, and jitter source. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
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
 *     (server/src/routes/contacts.ts) with no session required — anyone
 *     holding the link can open it. "unlisted" additionally stays out of
 *     Store browse/search (server/src/domain/agentCreation.ts, the default
 *     for every agent this command creates) — that's the one fact worth
 *     telling the owner, since it isn't visible from the link itself.
 *   - "private" 404s from that same route, indistinguishable from a
 *     handle that does not exist; the signed-in counterpart at
 *     GET /v1/contacts/:handle only admits the owner
 *     (`or(ne(visibility, "private"), eq(ownerUserId, user.id))`).
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

/**
 * Relay's handle grammar, enforced here so a machine name that cannot become
 * one is reported before the device flow spends the person's time:
 * 3–32 characters, first a lowercase letter, then lowercase letters, digits
 * or single underscores, never trailing.
 */
export const HANDLE_RULES =
  "a handle must be 3–32 characters, start with a lowercase letter, use only lowercase " +
  "letters, numbers, or underscores, and cannot end with or repeat underscores";

export function isValidAgentHandle(value: string): boolean {
  return /^[a-z][a-z0-9_]{2,31}$/.test(value)
    && !value.endsWith("_")
    && !value.includes("__");
}

/** Best-effort handle for a machine name; undefined when nothing valid survives. */
export function handleFromDeviceName(deviceName: string): string | undefined {
  const candidate = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  return isValidAgentHandle(candidate) ? candidate : undefined;
}

async function finalizeSavedAgent(
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
        `Agent API key is safely stored, but owner lookup failed (${error instanceof Error ? error.message : error}). ` +
          "Run `relaymessenger pair` again to resume owner pinning with this saved key; " +
          "it will not create or overwrite an agent.",
      );
    }
  }
  if (!ownerUserId) {
    throw new Error(
      "Agent API key is safely stored, but the server did not report owner_user_id and " +
        "RELAY_OWNER_USER_ID is not set. The bridge fails closed without a pinned owner. " +
        "Set RELAY_OWNER_USER_ID, then run `relaymessenger pair` again to finalize this saved key.",
    );
  }
  const agent = {
    ...(saved.agent ?? {}),
    ...(apiAgent ?? {}),
  } as RelayConfig["agent"];
  config.save({ ...saved, agent, owner_user_id: ownerUserId });
  out(`Owner pinned: ${ownerUserId}. Only this user can drive the bridge.`);

  // The agent's own profile — printed here because this is the first point
  // the CLI has a live, owner-pinned handle. Reuses the same renderQr the
  // approval QR above used.
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

/**
 * RFC 8628 §3.4-3.5. Every terminal state gets its own message, because the
 * five of them ask the operator for five different things.
 */
async function awaitDeviceApproval(
  client: RelayClient,
  grant: DeviceCodeGrant,
  out: (line: string) => void,
  clock: { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number },
): Promise<string> {
  const deadline = clock.now() + grant.expires_in * 1_000;
  let intervalMs = Math.max(1, grant.interval) * 1_000;
  const expired = () =>
    new Error(
      "The code expired before it was approved in the Relay app. Run `relaymessenger pair` again.",
    );

  for (;;) {
    // Jitter on top of the interval, not inside it: the server measures every
    // poll against `lastPolledAt`, rejected ones included, so arriving at
    // exactly `interval` intermittently reads as too fast and trips slow_down.
    await clock.sleep(intervalMs + Math.floor(clock.random() * 1_000));
    if (clock.now() >= deadline) throw expired();

    let result;
    try {
      result = await client.pollDeviceToken(grant.device_code, DEVICE_CLIENT_ID);
    } catch (error) {
      // Network blip: the grant is untouched, so keep waiting until expiry.
      out(`(retrying: ${error instanceof Error ? error.message : error})`);
      continue;
    }

    switch (result.kind) {
      case "token":
        return result.access_token;
      case "transient":
        out(`(retrying: ${result.message})`);
        continue;
      case "request_error":
        throw new Error(
          `Relay rejected the approval request: ${result.message}` +
            `${result.code ? ` (${result.code})` : ""}.`,
        );
      case "oauth_error":
        switch (result.error) {
          case "authorization_pending":
            continue;
          case "slow_down":
            // RFC 8628 §3.5: widen by five seconds and keep the same code.
            intervalMs += 5_000;
            continue;
          case "access_denied":
            throw new Error(
              "The request was declined in the Relay app. Run `relaymessenger pair` again to ask for a new code.",
            );
          case "expired_token":
            throw expired();
          case "invalid_grant":
            throw new Error(
              "Relay no longer recognises this code — it was already used, or it belongs to another " +
                "device. Run `relaymessenger pair` again for a fresh one.",
            );
          default:
            throw new Error(
              `Relay refused the approval (${result.error})` +
                `${result.error_description ? `: ${result.error_description}` : ""}.`,
            );
        }
    }
  }
}

export async function pair(options: PairOptions): Promise<void> {
  const out = options.out ?? console.log;
  const config = options.config ?? new ConfigStore();
  const client = options.client ?? new RelayClient(options.origin);
  const deviceName = options.deviceName ?? hostname();
  const renderQr =
    options.renderQr ?? ((url: string) => qrcode.generate(url, { small: true }));
  const clock = {
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    random: options.random ?? Math.random,
  };

  const existing = config.load();
  if (
    existing?.agent_token &&
    !existing.owner_user_id &&
    existing.api_origin === client.origin
  ) {
    out("Resuming owner pinning for the Agent API key already stored on this machine.");
    try {
      await finalizeSavedAgent(existing, config, options.agentClientFor, out, renderQr);
      return;
    } catch (error) {
      if (!(error instanceof RelayApiError) || error.status !== 401) throw error;
      out("Saved Agent API key was rejected (401); starting a fresh approval for this origin.");
    }
  }

  // Refuse before the person is asked to approve anything: the handle is only
  // needed at the very end, and finding out then wastes the whole approval.
  const handle = options.handle ?? handleFromDeviceName(deviceName);
  if (!handle) {
    throw new Error(
      `Cannot derive an agent handle from "${deviceName}" — ${HANDLE_RULES}. ` +
        "Pass one with `relaymessenger pair --handle <handle>`.",
    );
  }
  if (!isValidAgentHandle(handle)) {
    throw new Error(`"${handle}" is not a valid handle — ${HANDLE_RULES}.`);
  }

  const grant = await client.requestDeviceCode(DEVICE_CLIENT_ID);
  const approvalUrl = grant.verification_uri_complete || grant.verification_uri;

  out("");
  out("Scan with the Relay app, or open the link on your phone:");
  out("");
  renderQr(approvalUrl);
  out("");
  out(`  ${approvalUrl}`);
  out(`  Enter this code: ${grant.user_code}`);
  out("");
  out(`Waiting for approval (expires in ${Math.round(grant.expires_in / 60)} min)…`);

  const sessionToken = await awaitDeviceApproval(client, grant, out, clock);

  let created;
  try {
    created = await client.createAgent(sessionToken, {
      handle,
      displayName: deviceName,
    } satisfies NewAgentBody);
  } catch (error) {
    if (error instanceof RelayApiError && error.status === 409) {
      const why = error.code === "handle_reserved" ? "is reserved by Relay" : "is already taken";
      throw new Error(
        `@${handle} ${why}. Run \`relaymessenger pair --handle <handle>\` to choose another.`,
      );
    }
    throw error;
  }

  // Store the key before the first Agent API call, so an interrupted owner
  // pin can be resumed from this durable local copy instead of creating a
  // second agent.
  const saved: RelayConfig = {
    api_origin: client.origin,
    agent_token: created.token,
    agent: {
      ...(created.agent.id ? { id: created.agent.id } : {}),
      ...(created.agent.handle ? { handle: created.agent.handle } : {}),
      ...(created.agent.displayName ? { display_name: created.agent.displayName } : {}),
      ...(created.agent.visibility ? { visibility: created.agent.visibility } : {}),
    },
    paired_at: new Date().toISOString(),
  };
  config.save(saved);
  out("");
  out(`Approved. Agent API key stored in ${config.path} (mode 600).`);

  await finalizeSavedAgent(saved, config, options.agentClientFor, out, renderQr);
}
