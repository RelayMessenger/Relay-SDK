import type {
  MessageWebhookData,
  MessageSendParams,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";

import type { DurableInbox } from "./inbox.js";

export interface RelayMessageSender {
  chats: {
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

  await relay.chats.messages.send(event.data.chat.id, {
    message: {
      parts: [{ type: "text", value: metricsReply(event.data) }],
      idempotency_key: `relay-example:webhook:${event.event_id}`,
    },
  });
}

export class InboxProcessor {
  readonly #inbox: DurableInbox;
  readonly #relay: RelayMessageSender;
  #running = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(inbox: DurableInbox, relay: RelayMessageSender) {
    this.#inbox = inbox;
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
        const accepted = this.#inbox.claim();
        if (!accepted) break;
        try {
          await processAcceptedEvent(this.#relay, accepted.event);
          this.#inbox.complete(accepted.eventId);
        } catch (error) {
          const delayMs = Math.min(
            60_000,
            1_000 * 2 ** Math.min(accepted.attempts - 1, 6),
          );
          this.#inbox.retry(
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
    const next = this.#inbox.nextAvailableAt();
    if (next === null) return;
    const delay = Math.min(2_147_483_647, Math.max(0, next - Date.now()));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
  }
}
