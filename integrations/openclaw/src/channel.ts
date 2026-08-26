// Relay channel plugin assembly: config/multi-account resolution,
// gateway long-poll lifecycle, durable message adapter, and inbound dispatch
// wiring. Transport logic lives in client/poll-loop/inbound/outbound modules;
// this file owns the OpenClaw adapter surfaces.
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import {
  DEFAULT_ACCOUNT_ID,
  listRelayAccountIds,
  resolveDefaultRelayAccountId,
  resolveRelayAccount,
} from "./accounts.js";
import { RelayAccountLock } from "./account-lock.js";
import { createRelayClient, isAbortError, RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import { createRelayCursorStore, openRelayCursorStateStore } from "./cursor-store.js";
import { createRelayInboundDedupeGuard, createRelayInboundDeduper } from "./inbound-dedupe.js";
import { buildRelayInboundFacts } from "./inbound.js";
import type { RelayInboundFacts } from "./inbound.js";
import { createRelayAccountLifecycleRegistry } from "./lifecycle.js";
import { RELAY_TEXT_CHUNK_LIMIT, sendRelayText } from "./outbound.js";
import { runRelayPollLoop } from "./poll-loop.js";
import { getRelayRuntime } from "./runtime.js";
import { relaySenderIsAllowed, resolveRelayAllowedSenderIds } from "./security.js";
import type { RelayCoreConfig, ResolvedRelayAccount } from "./types.js";

export const RELAY_CHANNEL_ID = "relay" as const;

const relayMeta = {
  id: RELAY_CHANNEL_ID,
  label: "Relay",
  selectionLabel: "Relay",
  detailLabel: "Relay",
  docsPath: "https://docs.relayapp.im/integrations/openclaw",
  blurb: "Text your OpenClaw like a friend.",
  systemImage: "message",
  // Relay renders plain text plus typed parts; no markdown dialect, so core
  // strips formatting instead of leaking `**`.
  markdownCapable: false,
};

function relayClientForAccount(account: ResolvedRelayAccount): RelayClient {
  return createRelayClient({ baseUrl: account.baseUrl, token: account.token });
}

// ---------------------------------------------------------------------------
// Outbound: durable message adapter.
// ---------------------------------------------------------------------------

const relayMessageAdapter = defineChannelMessageAdapter({
  id: RELAY_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      // Plain per-send adapter functions: core's message-sending hooks run
      // around every send, which the default durable requirement derivation
      // demands (capabilities.ts requires it unless explicitly waived).
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const account = resolveRelayAccount({
        cfg: ctx.cfg as RelayCoreConfig,
        accountId: ctx.accountId,
      });
      if (!account.configured) {
        throw new Error(`relay: account "${account.accountId}" has no Agent Token configured`);
      }
      const result = await sendRelayText({
        client: relayClientForAccount(account),
        conversationId: ctx.to,
        text: ctx.text,
        replyToId: ctx.replyToId ?? null,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: RELAY_CHANNEL_ID, messageId: result.messageId }],
          replyToId: ctx.replyToId ?? undefined,
          kind: "text",
        }),
      };
    },
  },
  receive: {
    // Cursor acks after a durable at-most-once attempt marker is written.
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
  },
});

// ---------------------------------------------------------------------------
// Inbound dispatch — qa-channel-shaped runtime wiring.
// ---------------------------------------------------------------------------

async function dispatchRelayInbound(params: {
  cfg: OpenClawConfig;
  account: ResolvedRelayAccount;
  facts: RelayInboundFacts;
  client: RelayClient;
  allowedSenderIds: readonly string[];
  markAttempt: () => Promise<void>;
}): Promise<void> {
  const { account, facts } = params;
  // Public Relay agents are discoverable, so contact membership is not an
  // authorization boundary. Only the API-pinned owner and explicit operator
  // allowlist entries may start an OpenClaw turn.
  const dmPolicy = "allowlist" as const;
  const allowFrom = [...params.allowedSenderIds];
  const access = await resolveStableChannelMessageIngress({
    channelId: RELAY_CHANNEL_ID,
    accountId: account.accountId,
    identity: { key: "sender", entryIdPrefix: "relay-entry" },
    subject: { stableId: facts.senderId },
    conversation: { kind: "direct", id: facts.conversationId },
    dmPolicy,
    allowFrom,
  });
  if (access.ingress.admission !== "dispatch") {
    return;
  }
  const runtime = getRelayRuntime();
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: RELAY_CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: facts.conversationId },
    runtime: runtime.channel,
    sessionStore: (params.cfg as RelayCoreConfig).session?.store,
  });
  const commandAuthorized = relaySenderIsAllowed(params.allowedSenderIds, facts.senderId);
  const { storePath, body } = buildEnvelope({
    channel: relayMeta.label,
    from: facts.senderId,
    ...(facts.timestamp ? { timestamp: facts.timestamp } : {}),
    body: facts.text,
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: facts.text,
    RawBody: facts.text,
    CommandBody: facts.text,
    From: facts.conversationId,
    To: facts.conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? account.accountId,
    ChatType: "direct",
    ConversationLabel: facts.conversationId,
    SenderId: facts.senderId,
    SenderName: facts.senderId,
    Provider: RELAY_CHANNEL_ID,
    Surface: RELAY_CHANNEL_ID,
    MessageSid: facts.messageId,
    MessageSidFull: facts.messageId,
    ...(facts.replyToId ? { ReplyToId: facts.replyToId } : {}),
    ...(facts.timestamp ? { Timestamp: facts.timestamp } : {}),
    OriginatingChannel: RELAY_CHANNEL_ID,
    OriginatingTo: facts.conversationId,
    CommandAuthorized: commandAuthorized,
  });
  // A consumed inbound message with a silently lost reply is the worst
  // outcome. Delivery failures are surfaced, but the inbound attempt marker
  // prevents replaying an agent turn whose tools may already have run.
  let deliveryError: unknown;
  let fallbackDeliveryIndex = 0;
  const recordDeliveryError = (error: unknown) => {
    deliveryError ??= error;
  };
  // Admission, runtime resolution, route/session lookup, envelope building,
  // and context finalization above are replay-safe. The durable attempt starts
  // immediately before OpenClaw can invoke the agent or its tools.
  await params.markAttempt();
  await runtime.channel.inbound.dispatchReply({
    cfg: params.cfg,
    channel: RELAY_CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      // Final replies go through the durable message adapter: core renders
      // and chunks them (chunker + textChunkLimit) and tracks the send as a
      // durable queue intent, so a multi-chunk final gets core's queue-level
      // crash recovery. Replies land as plain messages, not quotes
      // (`replyToId: null`).
      durable: {
        to: facts.conversationId,
        replyToId: null,
      },
      // Fallback for payloads the durable path does not carry (non-final
      // visible blocks).
      deliver: async (payload) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        fallbackDeliveryIndex += 1;
        try {
          for (const chunk of chunkText(text, RELAY_TEXT_CHUNK_LIMIT)) {
            await sendRelayText({
              client: params.client,
              conversationId: facts.conversationId,
              text: chunk,
            });
          }
        } catch (error) {
          recordDeliveryError(error);
          throw error;
        }
      },
      onError: recordDeliveryError,
    },
    replyPipeline: {},
  });
  if (deliveryError) {
    throw deliveryError instanceof Error
      ? deliveryError
      : new Error(`relay reply delivery failed: ${String(deliveryError)}`);
  }
}

// ---------------------------------------------------------------------------
// Gateway lifecycle.
// ---------------------------------------------------------------------------

const relayAccountLifecycles = createRelayAccountLifecycleRegistry();

async function startRelayAccount(ctx: ChannelGatewayContext<ResolvedRelayAccount>): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(
      `Relay is not configured for account "${account.accountId}" (set channels.relay.token or ${account.accountId === DEFAULT_ACCOUNT_ID ? "RELAY_AGENT_TOKEN" : `channels.relay.accounts.${account.accountId}.token`}).`,
    );
  }
  const log = (line: string) => ctx.log?.info?.(line);
  const warn = (line: string) => ctx.log?.warn?.(line);
  const client = relayClientForAccount(account);
  const lifecycle = relayAccountLifecycles.acquire(account.accountId, ctx.abortSignal);
  const abortSignal = lifecycle.signal;
  let accountLock: RelayAccountLock | undefined;

  const markTerminalDisconnect = (error: Error) => {
    // Operator action required: flag terminalDisconnect so the supervisor
    // does not auto-restart (server-channels.ts:718).
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
      terminalDisconnect: true,
      lastError: error.message,
    });
  };

  try {
    const me = await client.getMe({ signal: abortSignal });
    const allowedSenderIds = resolveRelayAllowedSenderIds({
      profile: me,
      allowFrom: account.config.allowFrom,
    });
    if (allowedSenderIds.length === 0) {
      const error = new Error(
        `relay: account "${account.accountId}" has no owner pin. ` +
          "The Relay API did not return owner_user_id and channels.relay.allowFrom is empty.",
      );
      markTerminalDisconnect(error);
      throw error;
    }

    // Relay serves every poller, so nothing on the server stops two copies of
    // one agent from answering the same message twice. This lock does, across
    // processes and across two accounts that were handed the same token.
    // account.baseUrl is already canonical.
    accountLock = new RelayAccountLock(account.baseUrl, me.id, account.accountId);
    try {
      accountLock.acquire();
    } catch (error) {
      const lockError = error instanceof Error ? error : new Error(String(error));
      markTerminalDisconnect(lockError);
      throw lockError;
    }

    ctx.setStatus({
      accountId: account.accountId,
      running: true,
      connected: true,
      configured: true,
      enabled: account.enabled,
    });

    const cursorStore = createRelayCursorStore({
      store: openRelayCursorStateStore(warn),
      baseUrl: account.baseUrl,
      agentId: me.id,
      onPersistError: (error) => warn(`[relay] cursor persistence failed: ${String(error)}`),
    });
    await cursorStore.load();
    const deduper = createRelayInboundDeduper({
      guard: createRelayInboundDedupeGuard({
        onDiskError: (error) => warn(`[relay] inbound dedupe persistence failed: ${String(error)}`),
      }),
      baseUrl: account.baseUrl,
      agentId: me.id,
    });

    await runRelayPollLoop({
      client,
      cursorStore,
      deduper,
      abortSignal,
      timeoutSeconds: account.pollTimeoutSeconds,
      limit: 100,
      log,
      // Receipts, reactions, and echoes are acked without a dedupe row or a
      // dispatch: reaction.* is observe-only at v1, delivered/read
      // are bookkeeping.
      shouldProcess: (event) => buildRelayInboundFacts(event, { agentId: me.id }) !== null,
      onBatch: () => {
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          connected: true,
          lastInboundAt: Date.now(),
        });
      },
      handleEvent: async (event, markAttempt) => {
        const facts = buildRelayInboundFacts(event, { agentId: me.id });
        if (!facts) {
          return;
        }
        await dispatchRelayInbound({
          cfg: ctx.cfg,
          account,
          facts,
          client,
          allowedSenderIds,
          markAttempt,
        });
      },
    });
  } catch (error) {
    if (abortSignal.aborted || isAbortError(error)) {
      return;
    }
    // Named as `kind === "auth"`, not `error.terminal`. Only a bad token
    // needs an operator; every other non-retryable kind is left to the
    // supervisor's normal restart/backoff arbitration.
    if (error instanceof RelayApiError && error.kind === "auth") {
      markTerminalDisconnect(error);
    }
    throw error;
  } finally {
    accountLock?.release();
    lifecycle.release();
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
    });
  }
}

async function stopRelayAccount(
  ctx: ChannelGatewayContext<ResolvedRelayAccount>,
): Promise<void> {
  relayAccountLifecycles.stop(ctx.accountId);
  ctx.setStatus({
    accountId: ctx.accountId,
    running: false,
    connected: false,
  });
  ctx.log?.info?.(`[relay] stopped account "${ctx.accountId}"`);
}

// ---------------------------------------------------------------------------
// Plugin object.
// ---------------------------------------------------------------------------

export const relayChannelPlugin: ChannelPlugin<ResolvedRelayAccount> = createChatChannelPlugin({
  base: {
    id: RELAY_CHANNEL_ID,
    meta: relayMeta,
    capabilities: {
      // v1: direct conversations only; media flips on when the agent
      // attachment path ships. Reactions are observe-only.
      chatTypes: ["direct"],
      reply: true,
      threads: false,
      media: false,
      reactions: false,
    },
    reload: { configPrefixes: ["channels.relay"] },
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const coreCfg = cfg as RelayCoreConfig;
        const channelSection = { ...coreCfg.channels?.relay };
        const patch = input as Record<string, unknown>;
        const next =
          !accountId || accountId === DEFAULT_ACCOUNT_ID
            ? { ...channelSection, ...patch }
            : {
                ...channelSection,
                accounts: {
                  ...channelSection.accounts,
                  [accountId]: {
                    ...channelSection.accounts?.[accountId],
                    ...patch,
                  },
                },
              };
        return {
          ...cfg,
          channels: {
            ...coreCfg.channels,
            relay: next,
          },
        } as OpenClawConfig;
      },
    },
    config: {
      listAccountIds: (cfg) => listRelayAccountIds(cfg as RelayCoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultRelayAccountId(cfg as RelayCoreConfig),
      isConfigured: (account) => account.configured,
      inspectAccount: (cfg, accountId) => {
        const account = resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId });
        return {
          enabled: account.enabled,
          configured: account.configured,
          tokenStatus: account.configured ? "available" : "missing",
          baseUrl: account.baseUrl,
        };
      },
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveRelayAllowedSenderIds({
          profile: {},
          allowFrom: resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId }).config
            .allowFrom,
        }),
    },
    messaging: {
      targetResolver: {
        looksLikeId: (raw) => /^cnv_[A-Za-z0-9]+$/.test(raw.trim()),
        hint: "<cnv_…> (Relay conversation id from message.received)",
      },
    },
    gateway: {
      startAccount: startRelayAccount,
      stopAccount: stopRelayAccount,
    },
    heartbeat: {
      // Ephemeral typing indicator: POST typing start/stop.
      sendTyping: async ({ cfg, to, accountId }) => {
        const account = resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId });
        if (!account.configured) {
          return;
        }
        await relayClientForAccount(account).setTyping({ conversationId: to, started: true });
      },
      clearTyping: async ({ cfg, to, accountId }) => {
        const account = resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId });
        if (!account.configured) {
          return;
        }
        await relayClientForAccount(account).setTyping({ conversationId: to, started: false });
      },
    },
    message: relayMessageAdapter,
  },
  security: {
    dm: {
      channelKey: RELAY_CHANNEL_ID,
      resolvePolicy: () => "allowlist",
      resolveAllowFrom: (account) =>
        resolveRelayAllowedSenderIds({ profile: {}, allowFrom: account.config.allowFrom }),
      defaultPolicy: "allowlist",
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      // Core's renderer splits long replies before the adapter sees them
      // without a chunker the plan falls back to one oversized
      // unit, which the server 422s at its 8 KiB per-part cap.
      chunker: (text, limit) => chunkText(text, limit),
      chunkerMode: "text",
      textChunkLimit: RELAY_TEXT_CHUNK_LIMIT,
    },
    attachedResults: {
      channel: RELAY_CHANNEL_ID,
      sendText: async (ctx) => {
        const { cfg, to, text, accountId, replyToId } = ctx;
        const account = resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId });
        if (!account.configured) {
          throw new Error(`relay: account "${account.accountId}" has no Agent Token configured`);
        }
        const normalizedReplyToId = replyToId == null ? null : String(replyToId);
        const result = await sendRelayText({
          client: relayClientForAccount(account),
          conversationId: to,
          text,
          replyToId: normalizedReplyToId,
        });
        return { messageId: result.messageId };
      },
    },
  },
});
