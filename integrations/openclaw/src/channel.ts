// Relay channel plugin assembly: config/multi-account resolution,
// gateway long-poll lifecycle, durable message adapter, and inbound dispatch
// wiring. Transport logic lives in client/poll-loop/inbound/outbound modules;
// this file owns the OpenClaw adapter surfaces.
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";

/**
 * Read core's part index without requiring it to exist. Cores before
 * 2026.7.2-beta.5 have no `deliveryPartIndex` in their outbound context at all,
 * so naming the field directly would not typecheck against them. Reading it
 * through a widened shape keeps one source compiling on every supported core;
 * `deriveRelayIdempotencyKey` handles the undefined case.
 */
function deliveryPartIndexOf(ctx: unknown): number | undefined {
  const index = (ctx as { deliveryPartIndex?: unknown }).deliveryPartIndex;
  return typeof index === "number" ? index : undefined;
}
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
import {
  createRelayClient,
  isAbortError,
  isRelayWebhookConflict,
  RelayApiError,
} from "./client.js";
import type { RelayClient } from "./client.js";
import { createRelayCursorStore, openRelayCursorStateStore } from "./cursor-store.js";
import { createRelayInboundDedupeGuard, createRelayInboundDeduper } from "./inbound-dedupe.js";
import { buildRelayInboundFacts } from "./inbound.js";
import type { RelayInboundFacts } from "./inbound.js";
import { relayInvocationFor, rememberRelayInvocation } from "./invocations.js";
import { createRelayAccountLifecycleRegistry } from "./lifecycle.js";
import {
  deriveRelayIdempotencyKey,
  RELAY_TEXT_CHUNK_LIMIT,
  reconcileRelayUnknownSend,
  sendRelayText,
} from "./outbound.js";
import { runRelayPollLoop } from "./poll-loop.js";
import { markRespondingBeforeAttempt } from "./responding.js";
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
      const invocationId = relayInvocationFor({
        accountId: account.accountId,
        conversationId: ctx.to,
      });
      const verdict = await reconcileRelayUnknownSend({
        client: relayClientForAccount(account),
        conversationId: ctx.to,
        text,
        replyToId: ctx.effectiveReplyToId ?? ctx.replyToId ?? null,
        ...(invocationId ? { invocationId } : {}),
        idempotencyKey: deriveRelayIdempotencyKey({ deliveryQueueId: ctx.queueId }),
      });
      if (verdict.status === "sent") {
        return {
          status: "sent",
          messageId: verdict.messageId,
          // The 202 is an array: name every message the send committed.
          receipt: createMessageReceiptFromOutboundResults({
            results: verdict.messages.map((message) => ({
              channel: RELAY_CHANNEL_ID,
              messageId: message.id,
            })),
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
      // A group reply must name the invocation it answers. Core's send context
      // has no field for it, so the turn parks it in the invocation registry
      // under (accountId, conversationId) and it is read back here.
      const invocationId = relayInvocationFor({
        accountId: account.accountId,
        conversationId: ctx.to,
      });
      const result = await sendRelayText({
        client: relayClientForAccount(account),
        conversationId: ctx.to,
        text: ctx.text,
        replyToId: ctx.replyToId ?? null,
        ...(invocationId ? { invocationId } : {}),
        // Stable per (queueId, part): internal retries replay the same key,
        // so the server-side idempotent commit makes duplicates impossible by
        // contract. On a core with no part index the text names the part.
        idempotencyKey: deriveRelayIdempotencyKey({
          deliveryQueueId: ctx.deliveryQueueId,
          deliveryPartIndex: deliveryPartIndexOf(ctx),
          partText: ctx.text,
        }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        messageId: result.messageId,
        // The 202 is an array: name every message the send committed.
        receipt: createMessageReceiptFromOutboundResults({
          results: result.messages.map((message) => ({
            channel: RELAY_CHANNEL_ID,
            messageId: message.id,
          })),
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
  warn?: (line: string) => void;
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
  // Park the group invocation for the life of the turn. Core's durable send
  // adapter is a separate entry point with no inbound context, so this is how
  // the reply learns which invocation it answers.
  const releaseInvocation = facts.invocationId
    ? rememberRelayInvocation({
      accountId: account.accountId,
      conversationId: facts.conversationId,
      invocationId: facts.invocationId,
    })
    : () => {};
  try {
    // Admission, runtime resolution, route/session lookup, envelope building,
    // and context finalization above are replay-safe. The durable attempt starts
    // immediately before OpenClaw can invoke the agent or its tools.
    await markRespondingBeforeAttempt({
      client: params.client,
      facts,
      label: "OpenClaw",
      markAttempt: params.markAttempt,
      ...(params.warn ? { onReceiptFailure: params.warn } : {}),
    });
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
        // visible blocks). The event id + block/chunk ordinals identify each
        // logical send: retries reuse it while identical intentional blocks and
        // chunks remain distinct.
        deliver: async (payload) => {
          const text =
            payload && typeof payload === "object" && "text" in payload
              ? ((payload as { text?: string }).text ?? "")
              : "";
          if (!text.trim()) {
            return;
          }
          const logicalBlockId = `${facts.eventId}:block:${fallbackDeliveryIndex}`;
          fallbackDeliveryIndex += 1;
          try {
            let chunkIndex = 0;
            for (const chunk of chunkText(text, RELAY_TEXT_CHUNK_LIMIT)) {
              await sendRelayText({
                client: params.client,
                conversationId: facts.conversationId,
                text: chunk,
                ...(facts.invocationId ? { invocationId: facts.invocationId } : {}),
                idempotencyKey: deriveRelayIdempotencyKey({
                  deliveryQueueId: logicalBlockId,
                  deliveryPartIndex: chunkIndex,
                }),
              });
              chunkIndex += 1;
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
  } finally {
    releaseInvocation();
  }
}

// ---------------------------------------------------------------------------
// Gateway lifecycle.
// ---------------------------------------------------------------------------

/**
 * One long-poll consumer per agent token: two configured
 * accounts sharing a token would otherwise fight over the server's consumer
 * slot in an endless 409 loop. Keyed by (baseUrl, agentId) from getMe.
 */
const runningRelayAgentAccounts = new Map<string, string>();
const relayAccountLifecycles = createRelayAccountLifecycleRegistry();

export function relayAgentAccountKey(baseUrl: string, agentId: string): string {
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
  const lifecycle = relayAccountLifecycles.acquire(account.accountId, ctx.abortSignal);
  const abortSignal = lifecycle.signal;
  let agentKey: string | undefined;
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

    // Two accounts configured with the same token would fight over the
    // server's single consumer slot forever; keep the second one down until
    // the operator fixes the config. account.baseUrl is already canonical.
    agentKey = relayAgentAccountKey(account.baseUrl, me.id);
    const owner = runningRelayAgentAccounts.get(agentKey);
    if (owner !== undefined) {
      const error = new Error(
        `relay: agent ${me.id} is already polled by account "${owner}"; account "${account.accountId}" appears to reuse the same Agent Token. Give each account its own token.`,
      );
      markTerminalDisconnect(error);
      throw error;
    }
    accountLock = new RelayAccountLock(account.baseUrl, me.id, account.accountId);
    try {
      accountLock.acquire();
    } catch (error) {
      const lockError = error instanceof Error ? error : new Error(String(error));
      markTerminalDisconnect(lockError);
      throw lockError;
    }
    runningRelayAgentAccounts.set(agentKey, account.accountId);

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
          warn,
        });
      },
    });
  } catch (error) {
    if (abortSignal.aborted || isAbortError(error)) {
      return;
    }
    // Named as `kind === "auth"`, not `error.terminal`. The SDK client counts
    // every non-retryable kind as terminal, which would swallow the 409 cases
    // below — including `terminated_by_other_consumer`, whose whole point is
    // to fall through to the supervisor's restart arbitration.
    if (error instanceof RelayApiError && error.kind === "auth") {
      markTerminalDisconnect(error);
    } else if (isRelayWebhookConflict(error)) {
      // Webhook XOR: long polling stays 409 until the operator
      // disables the webhook endpoint — restarting cannot fix it.
      // `terminated_by_other_consumer` intentionally falls through to the
      // supervisor's normal restart/backoff arbitration.
      markTerminalDisconnect(error);
    }
    throw error;
  } finally {
    if (agentKey && runningRelayAgentAccounts.get(agentKey) === account.accountId) {
      runningRelayAgentAccounts.delete(agentKey);
    }
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
          // Stable when core supplies a logical queue id; otherwise fresh for
          // this invocation so two intentional identical sends remain two.
          idempotencyKey: deriveRelayIdempotencyKey({
            deliveryQueueId: ctx.deliveryQueueId,
            deliveryPartIndex: deliveryPartIndexOf(ctx),
            partText: text,
          }),
        });
        return { messageId: result.messageId };
      },
    },
  },
});
