/**
 * `relayapp pair` — device-code pairing (plan/12 §A1/§B).
 * POST /v1/pairings → terminal QR of the claim url + short code → long-poll
 * GET /v1/pairings/:id?wait=true until the phone claims it → store the
 * agent_token in ~/.relayapp/config.json (chmod 600). The token is delivered
 * exactly once; it never appears on the phone.
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

export async function pair(options: PairOptions): Promise<void> {
  const out = options.out ?? console.log;
  const config = options.config ?? new ConfigStore();
  const client = options.client ?? new RelayClient(options.origin);
  const deviceName = options.deviceName ?? hostname();

  const pairing = await client.createPairing(deviceName, options.engine);
  const renderQr =
    options.renderQr ?? ((url: string) => qrcode.generate(url, { small: true }));

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
        throw new Error("Pairing expired before it was claimed. Run `relayapp pair` again.");
      }
      if (error instanceof RelayApiError && error.status === 410) {
        throw new Error(
          "This pairing's token was already delivered. Run `relayapp pair` again for a fresh token.",
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
    throw new Error("Pairing expired before it was claimed. Run `relayapp pair` again.");
  }

  // Store the token first — it is delivered exactly once and must never be
  // lost to a later failure in this flow.
  const saved: RelayConfig = {
    api_origin: client.origin,
    agent_token: status.agent_token,
    agent: status.agent as any,
    paired_at: new Date().toISOString(),
  };
  config.save(saved);
  out("");
  out(`Paired. Agent token stored in ${config.path} (mode 600).`);

  // Pin the owner: everything the bridge does is gated on this user id.
  const agentClient =
    options.agentClientFor?.(status.agent_token) ??
    new RelayClient(client.origin, status.agent_token);
  let ownerUserId = process.env.RELAY_OWNER_USER_ID;
  if (!ownerUserId) {
    try {
      const me = (await agentClient.getMe()) as { owner_user_id?: string };
      ownerUserId = typeof me.owner_user_id === "string" ? me.owner_user_id : undefined;
    } catch (error) {
      throw new Error(
        `Token stored, but pinning the owner failed (${error instanceof Error ? error.message : error}). ` +
          "Re-run `relayapp pair`, or set RELAY_OWNER_USER_ID and it will be pinned on the next run.",
      );
    }
  }
  if (!ownerUserId) {
    throw new Error(
      "Token stored, but the server did not report owner_user_id and RELAY_OWNER_USER_ID " +
        "is not set. The bridge fails closed without a pinned owner: upgrade the server or " +
        "set RELAY_OWNER_USER_ID, then re-run `relayapp pair`.",
    );
  }
  config.save({ ...saved, owner_user_id: ownerUserId });
  out(`Owner pinned: ${ownerUserId}. Only this user can drive the bridge.`);
  out("Next: relayapp start --engine claude   (or --engine codex | --engine opencode)");
}
