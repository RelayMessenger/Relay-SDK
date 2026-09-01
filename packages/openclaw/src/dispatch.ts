import type {
  Message,
  Relay,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildRelayInboundFacts } from "./inbound.js";
import type { RelayIngressLifecycle } from "./ingress.js";
import type { PluginRuntime } from "./runtime.js";
import type {
  RelayCoreConfig,
  RelayInboundFacts,
  ResolvedRelayAccount,
} from "./types.js";

export type RelayTurnActivation =
  | {
      kind: "direct";
      wasMentioned: false;
      implicitMentionKinds: [];
    }
  | {
      kind: "mention";
      wasMentioned: true;
      implicitMentionKinds: [];
    }
  | {
      kind: "reply";
      wasMentioned: false;
      implicitMentionKinds: ["reply_to_bot"];
    };

type RelayReplyLookup = Pick<Relay, "messages">;

function isReplyToAgentMessage(
  message: Message,
  chatId: string,
): boolean {
  return message.chat_id === chatId && message.is_from_me === true;
}

/**
 * Relay's structured mention and reply facts are authoritative. In
 * particular, this does not infer an activation from visible `@handle` text.
 */
export async function resolveRelayTurnActivation(params: {
  facts: RelayInboundFacts;
  relay: RelayReplyLookup;
}): Promise<RelayTurnActivation | null> {
  if (params.facts.chatType === "direct") {
    return {
      kind: "direct",
      wasMentioned: false,
      implicitMentionKinds: [],
    };
  }

  const ownerHandle = params.facts.ownerHandle;
  if (
    ownerHandle?.kind === "agent" &&
    params.facts.mentionHandles.includes(ownerHandle.handle)
  ) {
    return {
      kind: "mention",
      wasMentioned: true,
      implicitMentionKinds: [],
    };
  }

  if (!params.facts.replyToId) return null;
  const replyTarget = await params.relay.messages.retrieve(
    params.facts.replyToId,
  );
  if (!isReplyToAgentMessage(replyTarget, params.facts.chatId)) return null;
  return {
    kind: "reply",
    wasMentioned: false,
    implicitMentionKinds: ["reply_to_bot"],
  };
}

export async function dispatchRelayEvent(params: {
  event: RelayWebhookEvent;
  lifecycle: RelayIngressLifecycle;
  account: ResolvedRelayAccount;
  cfg: RelayCoreConfig;
  relay: Pick<Relay, "chats" | "messages">;
  runtime: PluginRuntime;
  warn?: (message: string) => void;
}): Promise<void> {
  const facts = buildRelayInboundFacts(params.event);
  if (!facts) {
    params.warn?.(
      `relay: durably accepted ${params.event.event_type} event ${params.event.event_id} without an agent turn`,
    );
    return;
  }

  const activation = await resolveRelayTurnActivation({
    facts,
    relay: params.relay,
  });
  if (!activation) {
    params.warn?.(
      `relay: durably accepted unmentioned group Message ${facts.messageId} without an agent turn`,
    );
    return;
  }

  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg as OpenClawConfig,
    channel: "relay",
    accountId: params.account.accountId,
    peer: {
      kind: facts.chatType,
      id: facts.chatId,
    },
  });
  const restricted = params.account.allowFrom.length > 0;
  const effectiveAllowFrom = restricted
    ? params.account.allowFrom
    : ["*"];
  const access = await resolveStableChannelMessageIngress({
    channelId: "relay",
    accountId: params.account.accountId,
    identity: {
      key: "contactId",
      kind: "stable-id",
      entryIdPrefix: "relay-contact",
      aliases: [
        {
          key: "handle",
          kind: "username",
          normalize: (value) => value.trim().replace(/^@/u, "").toLowerCase(),
          dangerous: true,
        },
      ],
    },
    subject: {
      stableId: facts.contactId,
      aliases: { handle: facts.handle },
    },
    conversation: {
      kind: facts.chatType,
      id: facts.chatId,
      title: facts.chatType === "direct" ? facts.displayName : facts.chatId,
    },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: facts.messageId,
      nativeChannelId: facts.chatId,
      inboundEventKind: "user_request",
    },
    dmPolicy: restricted ? "allowlist" : "open",
    groupPolicy: restricted ? "allowlist" : "open",
    policy: {
      groupAllowFromFallbackToAllowFrom: true,
      ...(facts.chatType === "group"
        ? {
            activation: {
              requireMention: true,
              allowTextCommands: false,
              implicitMentions: {
                replyToBot: true,
                quotedBot: false,
                threadParticipation: false,
              },
              allowedImplicitMentionKinds: ["reply_to_bot"],
            },
          }
        : {}),
    },
    ...(facts.chatType === "group"
      ? {
          mentionFacts: {
            canDetectMention: true,
            wasMentioned: activation.wasMentioned,
            hasAnyMention: facts.mentionHandles.length > 0,
            implicitMentionKinds: activation.implicitMentionKinds,
          },
        }
      : {}),
    allowFrom: effectiveAllowFrom,
    groupAllowFrom: effectiveAllowFrom,
  });
  if (access.ingress.admission !== "dispatch") {
    params.warn?.(
      `relay: Contact @${facts.handle} did not pass OpenClaw ingress (${access.ingress.decision}:${access.ingress.reasonCode})`,
    );
    return;
  }

  const body = buildEnvelope({
    channel: "Relay",
    from: `${facts.displayName} (@${facts.handle})`,
    ...(facts.timestamp ? { timestamp: facts.timestamp } : {}),
    body: facts.text,
  });
  const ctxPayload = buildChannelInboundEventContext({
    channel: "relay",
    accountId: route.accountId ?? params.account.accountId,
    messageId: facts.messageId,
    messageIdFull: facts.messageId,
    ...(facts.timestamp ? { timestamp: facts.timestamp } : {}),
    from: facts.chatId,
    sender: {
      id: facts.contactId,
      name: facts.displayName,
      username: facts.handle,
    },
    conversation: {
      kind: facts.chatType,
      id: facts.chatId,
      label: facts.chatType === "group" ? facts.chatId : facts.displayName,
      nativeChannelId: facts.chatId,
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
      ...(route.dmScope ? { dmScope: route.dmScope } : {}),
    },
    reply: {
      to: facts.chatId,
      originatingTo: facts.chatId,
      ...(facts.replyToId ? { replyToId: facts.replyToId } : {}),
    },
    message: {
      inboundEventKind: "user_request",
      body,
      bodyForAgent: facts.text,
      rawBody: facts.text,
      commandBody: facts.text,
    },
    channelIngress: access,
    access: {
      commands: {
        authorized: access.senderAccess.allowed,
      },
      mentions: {
        canDetectMention: facts.chatType === "group",
        wasMentioned: activation.wasMentioned,
        hasAnyMention: facts.mentionHandles.length > 0,
        explicitlyMentionedBot: activation.kind === "mention",
        implicitMentionKinds: activation.implicitMentionKinds,
        requireMention: facts.chatType === "group",
        effectiveWasMentioned: facts.chatType === "group",
      },
    },
  });

  await Promise.allSettled([
    params.relay.chats.markAsRead(facts.chatId),
    params.relay.chats.startTyping(facts.chatId),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        params.warn?.(`relay: pre-dispatch Chat state failed: ${String(result.reason)}`);
      }
    }
  });

  let deliveryError: unknown;
  try {
    await params.runtime.channel.inbound.dispatch({
      cfg: params.cfg as OpenClawConfig,
      channel: "relay",
      accountId: params.account.accountId,
      route: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        ...(route.dmScope ? { dmScope: route.dmScope } : {}),
      },
      ctxPayload,
      delivery: {
        durable: {
          to: facts.chatId,
          replyToId: null,
          requiredCapabilities: { reconcileUnknownSend: true },
        },
        deliver: async (_payload, info) => {
          if (info.kind === "final") {
            throw new Error(
              "relay: durable final Message delivery was unavailable",
            );
          }
          return { visibleReplySent: false };
        },
        onError: (error) => {
          deliveryError ??= error;
        },
      },
      replyPipeline: {},
      replyOptions: {
        ...bindIngressLifecycleToReplyOptions(params.lifecycle),
        disableBlockStreaming: true,
      },
      record: {
        onRecordError: (error) => {
          throw error instanceof Error
            ? error
            : new Error(`relay: session record failed: ${String(error)}`);
        },
      },
    });
    if (deliveryError) {
      throw deliveryError instanceof Error
        ? deliveryError
        : new Error(`relay: reply delivery failed: ${String(deliveryError)}`);
    }
  } finally {
    await params.relay.chats.stopTyping(facts.chatId).catch((error: unknown) => {
      params.warn?.(`relay: stop typing failed: ${String(error)}`);
    });
  }
}
