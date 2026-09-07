import {
  type Relay,
  RelayWebhookConfiguredError,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { createHash } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { dispatchRelayEvent } from "./dispatch.js";
import { commitRelayFullSync } from "./full-sync.js";
import { createRelayIngressMonitor } from "./ingress.js";
import { createRelaySdkClient } from "./outbound.js";
import { getRelayRuntime } from "./runtime.js";
import {
  openRelayStateStore,
  type RelayStateStore,
} from "./state.js";
import type {
  RelayCoreConfig,
  RelayIngressPayload,
  ResolvedRelayAccount,
} from "./types.js";

const runningCredentials = new Map<string, string>();
const accountControllers = new Map<string, AbortController>();

function credentialKey(account: ResolvedRelayAccount): string {
  return createHash("sha256")
    .update(`${account.baseUrl}\0${account.token}`)
    .digest("hex");
}

function openIngressQueue(params: {
  transportId: string;
  state: RelayStateStore;
  warn: (message: string) => void;
}): ChannelIngressQueue<RelayIngressPayload> {
  try {
    return getRelayRuntime().state.openChannelIngressQueue<RelayIngressPayload>({
      accountId: params.transportId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("only available for trusted plugins")) throw error;
    params.warn(
      "relay: OpenClaw trusted ingress state is unavailable for this install; using the plugin's private SQLite queue",
    );
    return params.state.ingressQueue;
  }
}

export async function assertRelayWebSocketAvailable(params: {
  relay: Pick<Relay, "webhookSubscriptions">;
  accountId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { subscriptions } = await params.relay.webhookSubscriptions.list(
    params.signal ? { signal: params.signal } : undefined,
  );
  if (subscriptions.length > 0) {
    throw new RelayWebhookConfiguredError(
      `relay: account "${params.accountId}" has saved Webhook subscriptions; delete them before using OpenClaw WebSocket delivery`,
    );
  }
}

export async function startRelayAccount(
  ctx: ChannelGatewayContext<ResolvedRelayAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(
      `relay: account "${account.accountId}" is missing a Relay Agent Token`,
    );
  }
  const runtime = getRelayRuntime();
  const controller = new AbortController();
  const abortSignal = AbortSignal.any([ctx.abortSignal, controller.signal]);
  const key = credentialKey(account);
  const transportId = `transport-${key}`;
  const existing = runningCredentials.get(key);
  if (existing) {
    throw new Error(
      `relay: account "${account.accountId}" reuses the Agent Token already active in account "${existing}"`,
    );
  }
  runningCredentials.set(key, account.accountId);
  accountControllers.set(account.accountId, controller);

  const warn = (message: string) => ctx.log?.warn?.(message);
  const state = openRelayStateStore({
    stateDir: runtime.state.resolveStateDir(),
    // Bind pending events and FULL-sync state to the authenticated transport,
    // not a mutable OpenClaw account label. Token rotation cannot dispatch old
    // rows through a different Relay Contact, and account renames keep state.
    accountId: transportId,
  });
  const relay = createRelaySdkClient(account);
  const ingress = createRelayIngressMonitor({
    queue: openIngressQueue({
      transportId,
      state,
      warn,
    }),
    abortSignal,
    onError: (error) =>
      ctx.log?.error?.(`relay: ingress drain failed: ${String(error)}`),
    dispatch: async (event, lifecycle) => {
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        connected: true,
        lastInboundAt: Date.now(),
      });
      await dispatchRelayEvent({
        event,
        lifecycle,
        account,
        cfg: ctx.cfg as RelayCoreConfig,
        relay,
        runtime,
        warn,
      });
    },
  });

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    connected: false,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
  });

  try {
    await assertRelayWebSocketAvailable({
      relay,
      accountId: account.accountId,
      signal: abortSignal,
    });

    ingress.start();
    ctx.setStatus({
      accountId: account.accountId,
      running: true,
      connected: true,
      lifecycle: "ready",
      lastError: null,
    });
    await relay.websocket.run({
      signal: abortSignal,
      onEvent: async (
        event: RelayWebhookEvent,
      ) => {
        const admission = await ingress.receive(event);
        if (admission.kind === "invalid") {
          throw new Error(admission.message);
        }
      },
      onFullSync: async (context) => {
        await commitRelayFullSync({ relay, state, context });
      },
      onError: (error) => {
        ctx.log?.warn?.(`relay: WebSocket reconnecting after ${String(error)}`);
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          connected: false,
          lifecycle: "recovering",
          lastError: error instanceof Error ? error.message : String(error),
        });
      },
    });
  } catch (error) {
    if (abortSignal.aborted) return;
    if (error instanceof RelayWebhookConfiguredError) {
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        connected: false,
        terminalDisconnect: true,
        lastError: error.message,
      });
    }
    throw error;
  } finally {
    await ingress.stop();
    if (runningCredentials.get(key) === account.accountId) {
      runningCredentials.delete(key);
    }
    if (accountControllers.get(account.accountId) === controller) {
      accountControllers.delete(account.accountId);
    }
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
      lifecycle: "stopped",
    });
  }
}

export async function stopRelayAccount(
  ctx: ChannelGatewayContext<ResolvedRelayAccount>,
): Promise<void> {
  accountControllers.get(ctx.accountId)?.abort(
    new Error(`relay: account "${ctx.accountId}" stopped`),
  );
  ctx.setStatus({
    accountId: ctx.accountId,
    running: false,
    connected: false,
    lifecycle: "stopped",
  });
}
