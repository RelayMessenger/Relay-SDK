import {
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
  type RelayAdapter,
} from "@relaymessenger/chat-sdk-adapter";

import type { Bindings } from "./env";
import {
  requireRelayAgentHandle,
  requireRelayToken,
  requireRelayWebhookSecret,
} from "./env";
import { starterModel } from "./model";
import {
  createReplyAction,
  type RelayTurnIdentity,
} from "./reply";

export { ThinkMessengerStateAgent };

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
// Relay's downstream Message idempotency key makes immediate reclaim safe.
const ACTION_RETRY_LEASE_MS = 0;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The Worker's single Relay client.
 *
 * Inbound and outbound both go through this one adapter, so there is one
 * credential resolver, one `fetch` override and one retry policy for every
 * Relay call the agent makes.
 */
export function createRelayAdapterFor(env: Bindings): RelayAdapter {
  const handle = requireRelayAgentHandle(env);
  return createRelayAdapter({
    // `abortActiveTurnOnReceipt` is deliberately left off. It cancels the Chat
    // SDK's turn, and Think never reads that signal, so under Think the Worker
    // cancels through `cancelAllChats()` in src/index.ts instead.
    baseUrl: env.RELAY_API_ORIGIN,
    // The read states that the message arrived. It is stamped on receipt so
    // no debounce window and no model turn can delay it.
    markReadOnReceipt: true,
    token: requireRelayToken(env),
    typing: false,
    userName: handle,
    webhookSecret: requireRelayWebhookSecret(env),
  });
}

export function createRelayMessenger(
  env: Bindings,
  adapter: RelayAdapter,
) {
  const handle = requireRelayAgentHandle(env);
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
    delivery: {
      emptyResponseText: "",
      errorResponseText: "",
      interruptedResponseText: "",
      // Relay output is committed once by the native reply Action. Think's
      // streamed model text must never become a second or partial Message.
      splitText: () => [],
      visibleSoftLimit: 0,
    },
    path: RELAY_WEBHOOK_PATH,
    provider: "relay",
    respondTo: ["direct-message", "mention"],
    // Concurrency is not a messenger option. Think constructs the Chat SDK
    // instance itself and fixes `{ strategy: "burst", debounceMs: 600 }`
    // (@cloudflare/think 0.17.0, dist/chat-sdk-C8BvREXn.js:421-424), so a
    // burst of messages already collapses into one reply — but the window is
    // Think's 600 ms, not a value this Worker can choose.
    // The Relay adapter verifies Standard Webhooks over the exact raw body.
    verifyWebhook: false,
    userName: handle,
  });
}

export class RelayChatAgent extends Think<Bindings> {
  private relayAdapter?: RelayAdapter;

  override actionLedgerPendingRetryLeaseMs = ACTION_RETRY_LEASE_MS;
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "",
  };
  override includeMcpTools = false;
  override maxSteps = 1;
  override sendReasoning = false;
  override workspaceBash = false;

  override getModel() {
    return starterModel(this.env);
  }

  override getSystemPrompt(): string {
    return [
      "You are a helpful agent in Relay Messenger.",
      "Answer naturally and call reply exactly once with the complete response.",
      "Do not emit a second answer after the reply Action.",
    ].join(" ");
  }

  override getActions(): Record<string, Action> {
    return {
      reply: createReplyAction({
        adapter: () => this.adapter(),
        turn: () => this.relayTurn(),
      }),
    };
  }

  override getMessengers(): ThinkMessengers {
    return {
      relay: createRelayMessenger(this.env, this.adapter()),
    };
  }

  private adapter(): RelayAdapter {
    this.relayAdapter ??= createRelayAdapterFor(this.env);
    return this.relayAdapter;
  }

  override async beforeTurn(_context: TurnContext): Promise<TurnConfig> {
    // The chat was marked read on webhook receipt, by the adapter, before
    // this turn was ever scheduled. Nothing to do here but shape the turn.
    return {
      activeTools: _context.tools.reply ? ["reply"] : [],
      maxSteps: 1,
      sendReasoning: false,
      toolChoice: "required",
    };
  }

  private relayTurn(): RelayTurnIdentity {
    const context = this.getMessengerContext();
    const providerThreadId = context?.thread.providerThreadId;
    const messageId =
      context?.message?.providerMessageId ?? context?.message?.id;
    if (!providerThreadId) {
      throw new Error("Relay messenger context is missing a Chat ID");
    }
    const { chatId } = decodeRelayThreadId(providerThreadId);
    if (!messageId || !UUID.test(messageId)) {
      throw new Error("Relay messenger context is missing a Message ID");
    }
    return { chatId, messageId };
  }
}
