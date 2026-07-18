// Relay channel plugin assembly (doc 03): config/multi-account resolution,
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
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
import {
  DEFAULT_ACCOUNT_ID,
  listRelayAccountIds,
  resolveDefaultRelayAccountId,
  resolveRelayAccount,
} from "./accounts.js";
import { createRelayClient, isRelayWebhookConflict, RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import { createRelayCursorStore, RELAY_CURSOR_MAX_ENTRIES, RELAY_CURSOR_NAMESPACE } from "./cursor-store.js";
import type { RelayCursorRecord } from "./cursor-store.js";
import { createRelayInboundDedupeGuard, createRelayInboundDeduper } from "./inbound-dedupe.js";
import { buildRelayInboundFacts } from "./inbound.js";
import type { RelayInboundFacts } from "./inbound.js";
import {
  deriveRelayContentIdempotencyKey,
  deriveRelayIdempotencyKey,
  RELAY_TEXT_CHUNK_LIMIT,
  reconcileRelayUnknownSend,
  sendRelayText,
} from "./outbound.js";
import { runRelayPollLoop } from "./poll-loop.js";
import { getRelayRuntime } from "./runtime.js";
import type { RelayCoreConfig, ResolvedRelayAccount } from "./types.js";

export const RELAY_CHANNEL_ID = "relay" as const;

const relayMeta = {
  id: RELAY_CHANNEL_ID,
  label: "Relay",
  selectionLabel: "Relay",
  detailLabel: "Relay",
  docsPath: "/channels/relay",
  blurb: "Text your OpenClaw like a friend.",
  systemImage: "message",
  // Relay renders plain text plus typed parts; no markdown dialect, so core
  // strips formatting instead of leaking `**` (doc 03 §7).
  markdownCapable: false,
};

function relayClientForAccount(account: ResolvedRelayAccount): RelayClient {
  return createRelayClient({ baseUrl: account.baseUrl, token: account.token });
}

// ---------------------------------------------------------------------------
// Outbound: durable message adapter (doc 03 §5).
// ---------------------------------------------------------------------------

/**
 * Reconciliation can only prove sends whose idempotency key it can rebuild
 * exactly: one payload, one text, short enough that the renderer produced a
 * single platform send (partIndex 0). Anything else (multi-payload,
 * chunk-split, media) returns null so core keeps the intent unresolved
 * instead of replaying a body that differs from the original.
 */
function resolveSingleReconcilableText(ctx: {
  payloads: ReadonlyArray<unknown>;
  renderedBatchPlan?: { textCount: number; mediaCount: number; payloadCount: number };
}): string | null {
  if (ctx.payloads.length !== 1) {
    return null;
  }
  const payload = ctx.payloads[0];
  if (!payload || typeof payload !== "object" || !("text" in payload)) {
    return null;
  }
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  if (text.length > RELAY_TEXT_CHUNK_LIMIT) {
    return null;
  }
  const plan = ctx.renderedBatchPlan;
  if (plan && (plan.payloadCount !== 1 || plan.textCount > 1 || plan.mediaCount > 0)) {
    return null;
  }
  return text;
}

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
      reconcileUnknownSend: true,
    },
    // Only single-part text sends: that is what replaying one idempotency key
    // actually proves (multi-chunk sends have per-part keys and stay with the
    // normal retry path).
    reconcileUnknownSendKinds: { text: true },
    reconcileUnknownSend: async (ctx) => {
      const account = resolveRelayAccount({
        cfg: ctx.cfg as RelayCoreConfig,
        accountId: ctx.accountId,
      });
      if (!account.configured) {
        return { status: "unresolved", error: "relay account not configured", retryable: false };
      }
      const text = resolveSingleReconcilableText(ctx);
      if (text === null) {
        return null;
      }
      const verdict = await reconcileRelayUnknownSend({
        client: relayClientForAccount(account),
        conversationId: ctx.to,
        text,
        replyToId: ctx.effectiveReplyToId ?? ctx.replyToId ?? null,
        idempotencyKey: deriveRelayIdempotencyKey({ deliveryQueueId: ctx.queueId }),
      });
      if (verdict.status === "sent") {
        return {
          status: "sent",
          messageId: verdict.messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: RELAY_CHANNEL_ID, messageId: verdict.messageId }],
            kind: "text",
          }),
        };
      }
      return verdict;
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
        // Stable per (queueId, partIndex): internal retries replay the same
        // key, so the server-side idempotent commit makes duplicates
        // impossible by contract.
        idempotencyKey: deriveRelayIdempotencyKey({
          deliveryQueueId: ctx.deliveryQueueId,
          deliveryPartIndex: ctx.deliveryPartIndex,
        }),
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
    // Cursor acks after the claim/commit dance around agent dispatch (doc 03 §4).
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
  },
});

// ---------------------------------------------------------------------------
// Inbound dispatch (doc 03 §4) — qa-channel-shaped runtime wiring.
// ---------------------------------------------------------------------------

async function dispatchRelayInbound(params: {
  cfg: OpenClawConfig;
  account: ResolvedRelayAccount;
  facts: RelayInboundFacts;
  client: RelayClient;
}): Promise<void> {
  const runtime = getRelayRuntime();
  const { account, facts } = params;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: RELAY_CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: facts.conversationId },
    runtime: runtime.channel,
    sessionStore: (params.cfg as RelayCoreConfig).session?.store,
  });
  // Default allow-all only under the "open" policy (Relay DMs are already
  // scoped to users who added the contact, doc 03 §6) — core's open gate
  // still requires a wildcard or explicit entry (sender-gates.ts), and a
  // configured list narrows it. In "allowlist" mode the configured list
  // passes through unchanged so an absent/empty allowFrom denies.
  const dmPolicy = account.config.dmPolicy ?? "open";
  const allowFrom =
    dmPolicy === "open" ? (account.config.allowFrom ?? ["*"]) : account.config.allowFrom;
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
  // Control commands only for senders the operator explicitly listed; the
  // open-DM default authorizes conversation, not configuration.
  const commandAuthorized = (account.config.allowFrom ?? [])
    .map((entry) => String(entry))
    .includes(facts.senderId);
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
  // outcome, so delivery failures must fail the turn: the caller releases the
  // dedupe claim and the event replays.
  let deliveryError: unknown;
  const recordDeliveryError = (error: unknown) => {
    deliveryError ??= error;
  };
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
      // durable queue intent. Requiring reconcileUnknownSend forces
      // `durability: "required"`, so single-payload finals carry a stable
      // deliveryQueueId into send.text (stable idempotency key + exact
      // replay), and multi-chunk finals get core's queue-level crash
      // recovery. Replies land as plain messages, not quotes
      // (`replyToId: null`).
      durable: {
        to: facts.conversationId,
        replyToId: null,
        requiredCapabilities: { reconcileUnknownSend: true },
      },
      // Fallback for payloads the durable path does not carry (non-final
      // visible blocks): chunk here and use content-derived keys so a
      // transport retry cannot duplicate a visible send.
      deliver: async (payload) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        try {
          for (const chunk of chunkText(text, RELAY_TEXT_CHUNK_LIMIT)) {
            await sendRelayText({
              client: params.client,
              conversationId: facts.conversationId,
              text: chunk,
              idempotencyKey: deriveRelayContentIdempotencyKey({
                conversationId: facts.conversationId,
                text: chunk,
              }),
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
// Gateway lifecycle (doc 03 §3).
// ---------------------------------------------------------------------------

/**
 * Durable SQLite cursor for every install: `createPluginStateSyncKeyedStore`
 * writes plugin state directly and is not behind the trusted-install gate
 * that blocks `runtime.state.openKeyedStore` for npm-pack installs
 * (plugin-state-store.ts). The in-memory fallback only remains for a broken
 * state DB — then restart replays are absorbed by the persistent inbound
 * dedupe, at the cost of re-reading the retained backlog.
 */
function openRelayCursorStateStore(
  warn: (line: string) => void,
): Parameters<typeof createRelayCursorStore>[0]["store"] {
  try {
    const store = createPluginStateSyncKeyedStore<RelayCursorRecord>(RELAY_CHANNEL_ID, {
      namespace: RELAY_CURSOR_NAMESPACE,
      maxEntries: RELAY_CURSOR_MAX_ENTRIES,
    });
    return {
      lookup: async (key) => store.lookup(key),
      register: async (key, value) => {
        store.register(key, value);
      },
      delete: async (key) => store.delete(key),
    };
  } catch (error) {
    warn(
      `[relay] plugin state unavailable (${String(error)}); using in-memory cursor — restart replays are absorbed by the inbound dedupe.`,
    );
    const map = new Map<string, RelayCursorRecord>();
    return {
      lookup: async (key) => map.get(key),
      register: async (key, value) => {
        map.set(key, value);
      },
      delete: async (key) => map.delete(key),
    };
  }
}

/**
 * One long-poll consumer per agent token (plan 12 §A2): two configured
 * accounts sharing a token would otherwise fight over the server's consumer
 * slot in an endless 409 loop. Keyed by (baseUrl, agentId) from getMe.
 */
const runningRelayAgentAccounts = new Map<string, string>();

function relayAgentAccountKey(baseUrl: string, agentId: string): string {
  return `${baseUrl}\0${agentId}`;
}

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

  let me;
  try {
    me = await client.getMe({ signal: ctx.abortSignal });
  } catch (error) {
    if (error instanceof RelayApiError && error.terminal) {
      markTerminalDisconnect(error);
    }
    throw error;
  }

  // Two accounts configured with the same token would fight over the
  // server's single consumer slot forever; keep the second one down until
  // the operator fixes the config.
  const agentKey = relayAgentAccountKey(account.baseUrl, me.id);
  const owner = runningRelayAgentAccounts.get(agentKey);
  if (owner !== undefined && owner !== account.accountId) {
    const error = new Error(
      `relay: agent ${me.id} is already polled by account "${owner}"; account "${account.accountId}" appears to reuse the same Agent Token. Give each account its own token.`,
    );
    markTerminalDisconnect(error);
    throw error;
  }
  runningRelayAgentAccounts.set(agentKey, account.accountId);

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    configured: true,
    enabled: account.enabled,
  });

  try {
    const cursorStore = createRelayCursorStore({
      store: openRelayCursorStateStore(warn),
      accountId: account.accountId,
      agentId: me.id,
      onPersistError: (error) => warn(`[relay] cursor persistence failed: ${String(error)}`),
    });
    await cursorStore.load();
    const deduper = createRelayInboundDeduper({
      guard: createRelayInboundDedupeGuard({
        onDiskError: (error) => warn(`[relay] inbound dedupe persistence failed: ${String(error)}`),
      }),
      accountId: account.accountId,
    });

    await runRelayPollLoop({
      client,
      cursorStore,
      deduper,
      abortSignal: ctx.abortSignal,
      timeoutSeconds: account.pollTimeoutSeconds,
      limit: 100,
      log,
      // Receipts, reactions, and echoes are acked without a dedupe row or a
      // dispatch (doc 03 §4: reaction.* observe-only at v1, delivered/read
      // are bookkeeping).
      shouldProcess: (event) => buildRelayInboundFacts(event, { agentId: me.id }) !== null,
      onBatch: () => {
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          connected: true,
          lastInboundAt: Date.now(),
        });
      },
      handleEvent: async (event) => {
        const facts = buildRelayInboundFacts(event, { agentId: me.id });
        if (!facts) {
          return;
        }
        await dispatchRelayInbound({ cfg: ctx.cfg, account, facts, client });
        // Read watermark after the turn is handled: read implies delivered;
        // best effort — a failed receipt must not replay the event.
        await client
          .markRead({ conversationId: facts.conversationId, messageId: facts.messageId })
          .catch((error) => log(`[relay] markRead failed: ${String(error)}`));
      },
    });
  } catch (error) {
    if (error instanceof RelayApiError && error.terminal) {
      markTerminalDisconnect(error);
    } else if (isRelayWebhookConflict(error)) {
      // Webhook XOR (plan 12 §A2): long polling stays 409 until the operator
      // disables the webhook endpoint — restarting cannot fix it.
      // `terminated_by_other_consumer` intentionally falls through to the
      // supervisor's normal restart/backoff arbitration.
      markTerminalDisconnect(error);
    }
    throw error;
  } finally {
    runningRelayAgentAccounts.delete(agentKey);
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
    });
  }
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
      // attachment path ships (doc 03 §7, doc 06). Reactions are observe-only.
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
        resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId }).config.allowFrom,
    },
    messaging: {
      targetResolver: {
        looksLikeId: (raw) => /^cnv_[A-Za-z0-9]+$/.test(raw.trim()),
        hint: "<cnv_…> (Relay conversation id from message.received)",
      },
    },
    gateway: {
      startAccount: startRelayAccount,
    },
    heartbeat: {
      // Ephemeral typing indicator (doc 03 §5): POST typing start/stop.
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
      resolvePolicy: (account) => account.config.dmPolicy,
      resolveAllowFrom: (account) => account.config.allowFrom,
      // Allow-all by default: Relay DMs are already scoped to users who added
      // the agent as a contact (doc 03 §6).
      defaultPolicy: "open",
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      // Core's renderer splits long replies before the adapter sees them
      // (doc 03 §5): without a chunker the plan falls back to one oversized
      // unit, which the server 422s at its 8 KiB per-part cap.
      chunker: (text, limit) => chunkText(text, limit),
      chunkerMode: "text",
      textChunkLimit: RELAY_TEXT_CHUNK_LIMIT,
    },
    attachedResults: {
      channel: RELAY_CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, replyToId }) => {
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
          // No durable queue id on this compat path: derive the key from the
          // content so a caller retry replays instead of duplicating.
          idempotencyKey: deriveRelayContentIdempotencyKey({
            conversationId: to,
            text,
            replyToId: normalizedReplyToId,
          }),
        });
        return { messageId: result.messageId };
      },
    },
  },
});
