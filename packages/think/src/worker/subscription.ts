import {
  RELAY_WEBHOOK_EVENT_TYPES,
  type RelayWebhookEventType,
} from "@relaymessenger/chat-sdk-adapter";
import type Relay from "@relaymessenger/sdk";
import type { WebhookEventType, WebhookSubscription } from "@relaymessenger/sdk";

import { RELAY_CALL_EVENT_TYPES } from "../call-events.js";
import { RELAY_CHAT_CONTEXT_EVENT_TYPES } from "../chat-events.js";
import { RELAY_LOCATION_EVENT_TYPES } from "../location.js";
import { RELAY_PAYMENT_EVENT_TYPES } from "../payment.js";
import { RELAY_REACTION_EVENT_TYPES } from "../reactions.js";

/** Default path where Relay delivers webhooks on a Worker's own hostname. */
export const RELAY_WEBHOOK_PATH = "/webhooks/relay";

/** The event that opens a Chat. */
export const RELAY_CHAT_OPENED_EVENT = "chat.created";

/** Every event type a Think Relay agent handles by default. */
export const RELAY_HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.received",
  ...RELAY_CALL_EVENT_TYPES,
  ...RELAY_REACTION_EVENT_TYPES,
  ...RELAY_PAYMENT_EVENT_TYPES,
  ...RELAY_LOCATION_EVENT_TYPES,
  ...RELAY_CHAT_CONTEXT_EVENT_TYPES,
  RELAY_CHAT_OPENED_EVENT,
]);

/** The default subscription's `subscribed_events`, in the contract catalogue's order. */
export const RELAY_SUBSCRIBED_EVENTS: readonly RelayWebhookEventType[] =
  RELAY_WEBHOOK_EVENT_TYPES.filter((type) => RELAY_HANDLED_EVENT_TYPES.has(type));

/**
 * Filter a handled-event set against the canonical Relay webhook catalogue,
 * preserving contract order.
 */
export function subscribedRelayEvents(
  handled: ReadonlySet<string> = RELAY_HANDLED_EVENT_TYPES,
): RelayWebhookEventType[] {
  return RELAY_WEBHOOK_EVENT_TYPES.filter((type) => handled.has(type));
}

export interface ReconcileWebhookSubscriptionOptions {
  /** The full webhook destination URL (e.g. `https://agent.example/webhooks/relay`). */
  targetUrl: string;
  /** Event types the subscription should carry. Defaults to `RELAY_SUBSCRIBED_EVENTS`. */
  events?: readonly WebhookEventType[];
}

export type ReconcileWebhookSubscriptionResult =
  | {
    status: "unchanged";
    subscription: WebhookSubscription;
  }
  | {
    status: "updated";
    before: readonly WebhookEventType[];
    subscription: WebhookSubscription;
  };

function sameEventSet(
  actual: readonly string[],
  wanted: readonly string[],
): boolean {
  return actual.length === wanted.length
    && wanted.every((type) => actual.includes(type));
}

/**
 * Reconcile an agent's existing webhook subscription in place through
 * `PUT /v1/webhook-subscriptions/{id}`, preserving its signing secret.
 * Never creates a new subscription (which would mint a different secret).
 */
export async function reconcileWebhookSubscription(
  relay: Pick<Relay, "webhookSubscriptions">,
  options: ReconcileWebhookSubscriptionOptions,
): Promise<ReconcileWebhookSubscriptionResult> {
  const wanted: WebhookEventType[] = [...(options.events ?? RELAY_SUBSCRIBED_EVENTS)];
  const { subscriptions } = await relay.webhookSubscriptions.list();
  const matches = subscriptions.filter((entry) => entry.target_url === options.targetUrl);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one webhook subscription for ${options.targetUrl}, found ${matches.length}`,
    );
  }
  const current = matches[0]!;
  if (!current.is_active) {
    throw new Error(`Webhook subscription ${current.id} is inactive`);
  }
  if (sameEventSet(current.subscribed_events, wanted)) {
    return { status: "unchanged", subscription: current };
  }
  await relay.webhookSubscriptions.update(current.id, {
    subscribed_events: wanted,
  });
  const readBack = await relay.webhookSubscriptions.retrieve(current.id);
  if (
    !sameEventSet(readBack.subscribed_events, wanted)
    || readBack.target_url !== options.targetUrl
    || !readBack.is_active
  ) {
    throw new Error(`Webhook subscription ${current.id} did not read back as written`);
  }
  return {
    status: "updated",
    before: current.subscribed_events,
    subscription: readBack,
  };
}
