import type {
  MessageSendResponse,
} from "@relaymessenger/sdk";
import {
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import {
  DEFAULT_ACCOUNT_ID,
  listRelayAccountIds,
  resolveDefaultRelayAccountId,
  resolveRelayAccount,
} from "./accounts.js";
import {
  startRelayAccount,
  stopRelayAccount,
} from "./gateway.js";
import {
  classifyUnknownRelaySend,
  createRelaySdkClient,
  deriveRelayIdempotencyKey,
  RELAY_TEXT_CHUNK_LIMIT,
  sendRelayText,
} from "./outbound.js";
import type {
  RelayCoreConfig,
  ResolvedRelayAccount,
} from "./types.js";

export const RELAY_CHANNEL_ID = "relay" as const;

const relayMeta = {
  id: RELAY_CHANNEL_ID,
  label: "Relay",
  selectionLabel: "Relay",
  detailLabel: "Relay Messenger",
  docsPath: "https://docs.relayapp.im/integrations/openclaw",
  docsLabel: "Relay OpenClaw",
  blurb: "Message your OpenClaw through Relay.",
  systemImage: "message",
  markdownCapable: false,
  order: 70,
};

function requireAccount(
  cfg: RelayCoreConfig,
  accountId?: string | null | undefined,
): ResolvedRelayAccount {
  const account = resolveRelayAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(
      `relay: account "${account.accountId}" has no Relay Agent Token`,
    );
  }
  return account;
}

function receipt(
  messages: readonly MessageSendResponse[],
  replyToId?: string | null | undefined,
) {
  return createMessageReceiptFromOutboundResults({
    results: messages.map((result) => ({
      channel: RELAY_CHANNEL_ID,
      messageId: result.message.id,
      chatId: result.chat_id,
      conversationId: result.chat_id,
    })),
    ...(replyToId ? { replyToId } : {}),
    kind: "text",
  });
}

function reconciliationText(
  ctx: ChannelMessageUnknownSendContext,
): string | null {
  if (ctx.payloads.length !== 1) return null;
  if (
    ctx.renderedBatchPlan &&
    (ctx.renderedBatchPlan.payloadCount !== 1 ||
      ctx.renderedBatchPlan.mediaCount > 0)
  ) {
    return null;
  }
  const planned = ctx.renderedBatchPlan?.items[0]?.text;
  const payload = ctx.payloads[0];
  const text = planned ?? payload?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

async function reconcileRelayUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult | null> {
  const text = reconciliationText(ctx);
  if (text === null) return null;

  const account = requireAccount(
    ctx.cfg as RelayCoreConfig,
    ctx.accountId,
  );
  const relay = createRelaySdkClient(account);
  const responses: MessageSendResponse[] = [];
  const effectiveReplyToId =
    ctx.effectiveReplyToId !== undefined
      ? ctx.effectiveReplyToId
      : ctx.replyToId;
  try {
    const chunks = chunkText(text, RELAY_TEXT_CHUNK_LIMIT);
    for (const [index, chunk] of chunks.entries()) {
      responses.push(
        await sendRelayText({
          relay,
          chatId: ctx.to,
          text: chunk,
          replyToId: effectiveReplyToId,
          idempotencyKey: deriveRelayIdempotencyKey({
            deliveryQueueId: ctx.queueId,
            deliveryPartIndex: index,
          }),
        }),
      );
    }
    const first = responses[0];
    if (!first) {
      return {
        status: "unresolved",
        error: "relay: reconciliation produced no Message",
        retryable: false,
      };
    }
    return {
      status: "sent",
      messageId: first.message.id,
      receipt: receipt(responses, effectiveReplyToId),
    };
  } catch (error) {
    return classifyUnknownRelaySend(error);
  }
}

export const relayMessageAdapter = defineChannelMessageAdapter({
  id: RELAY_CHANNEL_ID,
  durableFinal: {
    automaticUnknownSendReconciliation: true,
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
      reconcileUnknownSend: true,
    },
    reconcileUnknownSendKinds: { text: true },
    reconcileUnknownSend: reconcileRelayUnknownSend,
  },
  send: {
    text: async (ctx) => {
      const account = requireAccount(
        ctx.cfg as RelayCoreConfig,
        ctx.accountId,
      );
      const response = await sendRelayText({
        relay: createRelaySdkClient(account),
        chatId: ctx.to,
        text: ctx.text,
        replyToId: ctx.replyToId,
        idempotencyKey: deriveRelayIdempotencyKey({
          deliveryQueueId: ctx.deliveryQueueId,
          deliveryPartIndex: ctx.deliveryPartIndex,
        }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.onPlatformSendDispatch
          ? { onPlatformSendDispatch: ctx.onPlatformSendDispatch }
          : {}),
      });
      return {
        messageId: response.message.id,
        receipt: receipt([response], ctx.replyToId),
      };
    },
  },
});

export const relayChannelPlugin: ChannelPlugin<ResolvedRelayAccount> =
  createChatChannelPlugin({
    base: {
      id: RELAY_CHANNEL_ID,
      meta: relayMeta,
      capabilities: {
        chatTypes: ["direct", "group"],
        reply: true,
        threads: false,
        media: false,
        reactions: false,
        edit: false,
        unsend: false,
        effects: false,
        blockStreaming: false,
      },
      reload: { configPrefixes: ["channels.relay"] },
      setup: {
        applyAccountConfig: ({ cfg, accountId, input }) => {
          const core = cfg as RelayCoreConfig;
          const section = { ...core.channels?.relay };
          const patch = input as Record<string, unknown>;
          const relay =
            !accountId || accountId === DEFAULT_ACCOUNT_ID
              ? { ...section, ...patch }
              : {
                  ...section,
                  accounts: {
                    ...section.accounts,
                    [accountId]: {
                      ...section.accounts?.[accountId],
                      ...patch,
                    },
                  },
                };
          return {
            ...cfg,
            channels: {
              ...core.channels,
              relay,
            },
          } as OpenClawConfig;
        },
      },
      config: {
        listAccountIds: (cfg) =>
          listRelayAccountIds(cfg as RelayCoreConfig),
        resolveAccount: (cfg, accountId) =>
          resolveRelayAccount({
            cfg: cfg as RelayCoreConfig,
            accountId,
          }),
        defaultAccountId: (cfg) =>
          resolveDefaultRelayAccountId(cfg as RelayCoreConfig),
        isConfigured: (account) => account.configured,
        inspectAccount: (cfg, accountId) => {
          const account = resolveRelayAccount({
            cfg: cfg as RelayCoreConfig,
            accountId,
          });
          return {
            enabled: account.enabled,
            configured: account.configured,
            tokenStatus: account.configured ? "available" : "missing",
            baseUrl: account.baseUrl,
          };
        },
        resolveAllowFrom: ({ cfg, accountId }) =>
          (() => {
            const account = resolveRelayAccount({
              cfg: cfg as RelayCoreConfig,
              accountId,
            });
            return account.allowFrom.length > 0
              ? account.allowFrom
              : ["*"];
          })(),
      },
      messaging: {
        targetPrefixes: ["relay"],
        normalizeTarget: (target) => {
          const normalized = target.trim().replace(/^relay:/iu, "");
          return normalized || undefined;
        },
        targetResolver: {
          looksLikeId: (raw) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              raw.trim().replace(/^relay:/iu, ""),
            ),
          hint: "<Relay Chat ID>",
        },
      },
      gateway: {
        startAccount: startRelayAccount,
        stopAccount: stopRelayAccount,
      },
      heartbeat: {
        sendTyping: async ({ cfg, to, accountId }) => {
          const account = requireAccount(
            cfg as RelayCoreConfig,
            accountId,
          );
          await createRelaySdkClient(account).chats.startTyping(to);
        },
        clearTyping: async ({ cfg, to, accountId }) => {
          const account = requireAccount(
            cfg as RelayCoreConfig,
            accountId,
          );
          await createRelaySdkClient(account).chats.stopTyping(to);
        },
      },
      message: relayMessageAdapter,
    },
    security: {
      dm: {
        channelKey: RELAY_CHANNEL_ID,
        resolvePolicy: (account) =>
          account.allowFrom.length > 0 ? "allowlist" : "open",
        resolveAllowFrom: (account) =>
          account.allowFrom.length > 0 ? account.allowFrom : ["*"],
        defaultPolicy: "open",
      },
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: (text, limit) => chunkText(text, limit),
        chunkerMode: "text",
        textChunkLimit: RELAY_TEXT_CHUNK_LIMIT,
      },
      attachedResults: {
        channel: RELAY_CHANNEL_ID,
        sendText: async (ctx) => {
          const account = requireAccount(
            ctx.cfg as RelayCoreConfig,
            ctx.accountId,
          );
          const response = await sendRelayText({
            relay: createRelaySdkClient(account),
            chatId: ctx.to,
            text: ctx.text,
            replyToId: ctx.replyToId,
            idempotencyKey: deriveRelayIdempotencyKey({
              deliveryQueueId: ctx.deliveryQueueId,
              deliveryPartIndex: ctx.deliveryPartIndex,
            }),
            ...(ctx.onPlatformSendDispatch
              ? { onPlatformSendDispatch: ctx.onPlatformSendDispatch }
              : {}),
          });
          return { messageId: response.message.id };
        },
      },
    },
  });
