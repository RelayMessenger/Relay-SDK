import {
  action,
  Think,
  type Action,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import {
  chatSdkMessenger,
  ThinkMessengerStateAgent,
  type ThinkMessengers,
} from "@cloudflare/think/messengers";
import {
  createRelayAdapter,
  decodeRelayThreadId,
} from "@relaymessenger/chat-sdk-adapter";
import {
  createRelayClient,
  RELAY_MESSENGER_DELIVERY,
  startRelayTypingLifecycle,
  withCardReplies,
  withLocationShares,
  withSelectionReplies,
} from "@relaymessenger/think";
import {
  RELAY_TURN_MAX_STEPS,
  relayActions,
  relayTurnSettled,
} from "@relaymessenger/think/actions";
import { stepCountIs } from "ai";

import type { Bindings } from "./env";
import {
  requireRelayAgentHandle,
  requireRelayToken,
  requireRelayWebhookSecret,
} from "./env";
import { PERSONA } from "./persona";
import {
  SEARCH_SOURCES_DESCRIPTION,
  searchSources,
  searchSourcesInputSchema,
} from "./search-sources";

export { ThinkMessengerStateAgent };

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
// Relay's downstream Message idempotency key makes immediate reclaim safe.
const ACTION_RETRY_LEASE_MS = 0;

export function createRelayMessenger(env: Bindings) {
  const handle = requireRelayAgentHandle(env);
  // The @relaymessenger/think wrappers add a person's selection, card
  // suggestion, and location share to the text the model reads.
  const adapter = withCardReplies(withLocationShares(withSelectionReplies(
    createRelayAdapter({
      baseUrl: env.RELAY_API_ORIGIN,
      token: requireRelayToken(env),
      // The agent holds the typing indicator for the whole model turn
      // (RelayChatAgent.chatWithMessengerContext).
      typing: false,
      userName: handle,
      webhookSecret: requireRelayWebhookSecret(env),
    }),
  )));
  return chatSdkMessenger({
    adapter,
    adapterName: "relay",
    capabilities: {
      canEditMessages: false,
      canStream: false,
      supportsActions: false,
      supportsAttachments: true,
    },
    // The Worker routes each signed Relay Chat to its own root Think instance.
    conversation: "self",
    // Relay Messages are the model's `send` calls. This policy keeps Think
    // from posting the model's own reply text as another Message.
    delivery: RELAY_MESSENGER_DELIVERY,
    path: RELAY_WEBHOOK_PATH,
    provider: "relay",
    respondTo: ["direct-message", "mention"],
    // The Relay adapter verifies Standard Webhooks over the exact raw body.
    verifyWebhook: false,
    userName: handle,
  });
}

export class RelayChatAgent extends Think<Bindings> {
  override actionLedgerPendingRetryLeaseMs = ACTION_RETRY_LEASE_MS;
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "",
  };
  override includeMcpTools = false;
  override maxSteps = RELAY_TURN_MAX_STEPS;
  override sendReasoning = false;
  override workspaceBash = false;

  override getModel() {
    // A Workers AI model id; Think runs it through the Worker's AI binding.
    return this.env.MODEL_ID;
  }

  override getSystemPrompt(): string {
    // The persona line, then how to answer in Relay (the starter's words).
    return [
      PERSONA,
      "Answer through the Relay tools: call send for each Message, one or several short ones in a row,"
        + " or react, or stay_silent when no answer is needed. Stop calling tools when you are done.",
    ].join("\n\n");
  }

  override getActions(): Record<string, Action> {
    return {
      // Every Relay tool: send, react, stay_silent and the rest.
      ...relayActions(this, {
        ctx: this.ctx,
        env: this.env,
        // This recipe has no voice model to talk on a call, so the model is
        // not offered start_call.
        voice: false,
      }),
      // The clone's own tool: a search of the person's public words.
      search_sources: action({
        description: SEARCH_SOURCES_DESCRIPTION,
        inputSchema: searchSourcesInputSchema,
        execute: (input, context) => searchSources(this.env, input.query, context.signal),
      }),
    };
  }

  override getMessengers(): ThinkMessengers {
    return { relay: createRelayMessenger(this.env) };
  }

  /** Holds Relay's typing indicator for the whole turn, then clears it. */
  override async chatWithMessengerContext(
    ...args: Parameters<Think<Bindings>["chatWithMessengerContext"]>
  ): Promise<void> {
    const providerThreadId = args[2].thread.providerThreadId;
    if (!providerThreadId) return super.chatWithMessengerContext(...args);
    const relay = createRelayClient(this.env);
    const { chatId } = decodeRelayThreadId(providerThreadId);
    const typing = startRelayTypingLifecycle(relay, chatId);
    try {
      await relay.chats.markAsRead(chatId).catch((error: unknown) => {
        console.warn(JSON.stringify({
          event: "relay_read_failed",
          chat_id: chatId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      await super.chatWithMessengerContext(...args);
    } finally {
      await (await typing).stop();
    }
  }

  override beforeTurn(context: TurnContext): TurnConfig {
    return {
      activeTools: Object.keys(context.tools),
      // relayTurnSettled ends the turn when the model calls no tool or calls
      // stay_silent; after search_sources the model goes on to answer. The
      // step cap ends a runaway turn.
      maxSteps: RELAY_TURN_MAX_STEPS,
      sendReasoning: false,
      stopWhen: [relayTurnSettled, stepCountIs(RELAY_TURN_MAX_STEPS)],
    };
  }
}
