import type {
  MessageWebhookData,
  MessageSendParams,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";

import type { RelayStore } from "./store.js";

export interface RelayMessageSender {
  chats: {
    markAsRead(chatId: string): Promise<void>;
    messages: {
      send(
        chatId: string,
        body: MessageSendParams,
      ): Promise<unknown>;
    };
  };
}

function metricsReply(data: MessageWebhookData): string {
  const text = data.parts
    .filter((part) => part.type === "text")
    .map((part) => part.value)
    .join("\n");
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  const characters = Array.from(text).length;
  const attachments = data.parts
    .filter((part) => part.type === "media")
    .length;
  return [
    `${words} word${words === 1 ? "" : "s"}`,
    `${characters} character${characters === 1 ? "" : "s"}`,
    `${attachments} attachment${attachments === 1 ? "" : "s"}`,
  ].join(", ");
}

export function shouldReply(data: MessageWebhookData): boolean {
  if (data.chat.is_group === false) return true;
  if (data.chat.is_group !== true || !data.chat.owner_handle) return false;
  const owner = data.chat.owner_handle.handle.replace(/^@/u, "").toLowerCase();
  return data.parts.some(
    (part) =>
      part.type === "text"
      && typeof part.mention === "string"
      && part.mention.replace(/^@/u, "").toLowerCase() === owner,
  );
}

/**
 * An answer to another agent replies to its Message, as a bot's reply names
 * the message it answers (Telegram `reply_to_message_id`): Relay's A2A door
 * gives a calling agent the reply that names its message. A person's Message
 * is not named. An agent may not reply to buttons or a selection, and a reply
 * names part 0.
 */
export function replyTo(
  data: MessageWebhookData,
): { reply_to: { message_id: string } } | Record<string, never> {
  // Read as a string: this example's pinned SDK types predate buttons and
  // selection parts, which Relay sends all the same.
  const opening: string | undefined = data.parts[0]?.type;
  return data.sender_handle.kind === "agent" && opening !== "buttons" && opening !== "selection"
    ? { reply_to: { message_id: data.id } }
    : {};
}

export async function processAcceptedEvent(
  relay: RelayMessageSender,
  event: RelayWebhookEvent,
): Promise<void> {
  if (
    event.event_type !== "message.received"
    || event.data.direction !== "inbound"
    || !shouldReply(event.data)
  ) {
    return;
  }
  // Read is a separate claim from the reply and never advances on its own
  // (docs quickstart, step 6): mark the Chat Read once the inbound Message has
  // been read, then send the reply independently.
  await relay.chats.markAsRead(event.data.chat.id);
  await relay.chats.messages.send(event.data.chat.id, {
    message: {
      parts: [{ type: "text", value: metricsReply(event.data) }],
      idempotency_key: `relay-example:websocket:${event.event_id}`,
      ...replyTo(event.data),
    },
  });
}

export class InboxProcessor {
  readonly #relay: RelayMessageSender;
  readonly #store: RelayStore;
  #running = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(store: RelayStore, relay: RelayMessageSender) {
    this.#store = store;
    this.#relay = relay;
  }

  start(): void {
    this.wake();
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    queueMicrotask(() => void this.#drain());
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      while (!this.#stopped) {
        const accepted = this.#store.claim();
        if (!accepted) break;
        try {
          await processAcceptedEvent(this.#relay, accepted.event);
          this.#store.complete(accepted.eventId);
        } catch (error) {
          const delayMs = Math.min(
            60_000,
            1_000 * 2 ** Math.min(accepted.attempts - 1, 6),
          );
          this.#store.retry(
            accepted.eventId,
            error,
            Date.now() + delayMs,
          );
        }
      }
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  #scheduleNext(): void {
    if (this.#stopped) return;
    const next = this.#store.nextAvailableAt();
    if (next === null) return;
    const delay = Math.min(2_147_483_647, Math.max(0, next - Date.now()));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
  }
}
