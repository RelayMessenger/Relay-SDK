import type Relay from "@relaymessenger/sdk";
import { signWebhookHeaders, type RelayWebhookEvent } from "@relaymessenger/sdk";
import { validateForwardURL } from "./config.js";

export interface ListenIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface ListenOptions {
  /** A loopback address to POST each event to. Required for `listen`;
   * optional for the older `events listen`, which prints when it is absent. */
  forwardTo?: string;
  /** The `whsec_` secret each forward is signed with, exactly the way a
   * deployed Relay webhook is signed. Required whenever `forwardTo` is set. */
  secret?: string;
  /** How to show each event on stdout: the raw JSON envelope (`events
   * listen`) or the one-line form `watch` prints (`listen`). */
  render?: (event: RelayWebhookEvent) => string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export const listenForAgentEvents = async (
  client: Relay,
  options: ListenOptions,
  io: ListenIO,
): Promise<void> => {
  const target = options.forwardTo
    ? validateForwardURL(options.forwardTo)
    : undefined;
  if (target && !options.secret) {
    throw new Error("A local signing secret is needed to forward events.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const render = options.render ?? ((event: RelayWebhookEvent) => JSON.stringify(event));
  const forwarded = options.render
    ? (event: RelayWebhookEvent): void => io.stdout(`${render(event)}\n`)
    : (event: RelayWebhookEvent): void => io.stderr(`forwarded ${event.event_type} ${event.event_id}\n`);

  await client.websocket.run({
    ...(options.signal ? { signal: options.signal } : {}),
    async onEvent(event: RelayWebhookEvent): Promise<void> {
      const body = JSON.stringify(event);
      if (!target) {
        io.stdout(`${render(event)}\n`);
        return;
      }
      // Signed over the exact bytes sent, so the developer's handler verifies
      // this POST with the same code it runs deployed.
      const response = await fetchImplementation(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signWebhookHeaders(options.secret!, { id: event.event_id, body }),
          "x-relay-event-id": event.event_id,
          "x-relay-event-type": event.event_type,
        },
        body,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(
          `The address you passed to --forward-to answered with error ${response.status}. Relay stopped so this event is not lost.`,
        );
      }
      forwarded(event);
    },
    async onFullSync(context): Promise<void> {
      throw new Error(
        "This agent has been away longer than Relay keeps its events, so Relay wants to send it everything it missed "
        + `up to number ${context.throughSequence}. This command only shows events as they arrive; it cannot go back. `
        + "Start the runtime you chose for this agent so it can catch up, or use a fresh test agent here.",
      );
    },
  });
};
