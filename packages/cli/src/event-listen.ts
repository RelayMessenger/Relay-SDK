import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { validateForwardURL } from "./config.js";

export interface ListenIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export const listenForAgentEvents = async (
  client: Relay,
  options: {
    forwardTo?: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  },
  io: ListenIO,
): Promise<void> => {
  const target = options.forwardTo
    ? validateForwardURL(options.forwardTo)
    : undefined;
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  await client.websocket.run({
    ...(options.signal ? { signal: options.signal } : {}),
    async onEvent(event: RelayWebhookEvent): Promise<void> {
      const body = JSON.stringify(event);
      if (!target) {
        io.stdout(`${body}\n`);
        return;
      }
      const response = await fetchImplementation(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-relay-dev-forwarded": "1",
          "x-relay-event-id": event.event_id,
          "x-relay-event-type": event.event_type,
        },
        body,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(
          `Local forward target returned HTTP ${response.status}; event was not acknowledged.`,
        );
      }
      io.stderr(`forwarded ${event.event_type} ${event.event_id}\n`);
    },
    async onFullSync(context): Promise<void> {
      throw new Error(
        `Relay requested FULL sync through sequence ${context.throughSequence}; `
        + "the stateless development listener cannot rebuild durable state.",
      );
    },
  });
};
