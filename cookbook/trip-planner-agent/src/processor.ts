import type {
  ChatHandle,
  MessagePartResponse,
  MessageSendParams,
  MessageWebhookData,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";

import { renderPlanParts, type ThreadMessage, type TripPlan, type TripPlanner } from "./plan.js";

/** Relay's typing indicator expires, so a long turn has to refresh it. */
const TYPING_REFRESH_MS = 5_000;

export interface RelayChatClient {
  chats: {
    markAsRead(chatId: string): Promise<void>;
    startTyping(chatId: string): Promise<void>;
    stopTyping(chatId: string): Promise<void>;
    messages: {
      send(chatId: string, body: MessageSendParams): Promise<unknown>;
    };
  };
}

export interface TripMemory {
  /** Every inbound Message, mentioned or not. Keyed by Message ID. */
  remember(chatId: string, messageId: string, message: ThreadMessage): void;
  thread(chatId: string): ThreadMessage[];
  currentPlan(chatId: string): TripPlan | null;
  /** The plan already written for this event, if the send is being retried. */
  plannedTurn(eventId: string): TripPlan | null;
  savePlannedTurn(eventId: string, chatId: string, plan: TripPlan): void;
}

export interface ProcessorDependencies {
  memory: TripMemory;
  planner: TripPlanner;
  relay: RelayChatClient;
}

const normalizeHandle = (handle: string): string =>
  handle.replace(/^@/u, "").toLowerCase();

export function authorName(handle: ChatHandle): string {
  return handle.display_name?.trim() || handle.handle;
}

/** What the agent is allowed to read: the words, and that a file was shared. */
export function messageText(parts: MessagePartResponse[]): string {
  return parts
    .map((part) => {
      if (part.type === "text" || part.type === "link") return part.value;
      if (part.type === "media") return "[attachment]";
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

/**
 * A direct Chat is always for the agent. A group Message is for the agent
 * only when a text part carries the structured mention of the agent's own
 * handle in that Chat - `chat.owner_handle` is the participant Relay marks
 * `is_me`. Matching the "@name" characters in the text is not enough,
 * because a person can type those characters without mentioning anyone.
 */
export function isAddressedToAgent(data: MessageWebhookData): boolean {
  if (data.chat.is_group === false) return true;
  if (data.chat.is_group !== true || !data.chat.owner_handle) return false;
  const me = normalizeHandle(data.chat.owner_handle.handle);
  return data.parts.some(
    (part) =>
      part.type === "text"
      && typeof part.mention === "string"
      && normalizeHandle(part.mention) === me,
  );
}

/** A typing indicator is a courtesy; losing one must not lose the answer. */
const bestEffort = async (work: Promise<void>): Promise<void> => {
  try {
    await work;
  } catch (error) {
    console.error(JSON.stringify({
      event: "relay_typing_indicator_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
};

async function planWhileTyping(
  { memory, planner, relay }: ProcessorDependencies,
  chatId: string,
): Promise<TripPlan> {
  await bestEffort(relay.chats.startTyping(chatId));
  const refresh = setInterval(() => {
    void bestEffort(relay.chats.startTyping(chatId));
  }, TYPING_REFRESH_MS);
  refresh.unref();
  try {
    return await planner.plan({
      thread: memory.thread(chatId),
      previous: memory.currentPlan(chatId),
    });
  } finally {
    clearInterval(refresh);
    await bestEffort(relay.chats.stopTyping(chatId));
  }
}

/**
 * One accepted event, from the durable inbox. Safe to run again: the plan
 * for an event is written before the send, so a retry re-sends the same
 * body under the same idempotency key instead of asking the model twice.
 */
export async function processAcceptedEvent(
  dependencies: ProcessorDependencies,
  event: RelayWebhookEvent,
): Promise<void> {
  if (event.event_type !== "message.received") return;
  const data = event.data;
  if (data.direction !== "inbound") return;

  const { memory, relay } = dependencies;
  const chatId = data.chat.id;

  memory.remember(chatId, data.id, {
    author: authorName(data.sender_handle),
    text: messageText(data.parts),
  });
  await relay.chats.markAsRead(chatId);

  if (!isAddressedToAgent(data)) return;

  let plan = memory.plannedTurn(event.event_id);
  if (!plan) {
    plan = await planWhileTyping(dependencies, chatId);
    memory.savePlannedTurn(event.event_id, chatId, plan);
  }

  await relay.chats.messages.send(chatId, {
    message: {
      parts: renderPlanParts(plan),
      reply_to: { message_id: data.id },
      idempotency_key: `relay-example:trip-planner:${event.event_id}`,
    },
  });
}
