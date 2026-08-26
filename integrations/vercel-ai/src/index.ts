import { RelayClient } from "./client.js";
import { createWebhookHandler, type WebhookHandler, type WebhookOptions } from "./webhook.js";

export { RelayApiError, RelayClient } from "./client.js";
export type {
  RelayClientOptions,
  SendOptions,
  TypingOptions,
} from "./client.js";
export {
  verifyWebhookSignature,
  WebhookSecretError,
  WebhookVerificationError,
} from "./signature.js";
export { relayId, ulid } from "./ulid.js";
export { createWebhookHandler } from "./webhook.js";
export type { WebhookContext, WebhookHandler, WebhookOptions } from "./webhook.js";
export type * from "./types.js";

export interface CreateRelayOptions {
  /** Agent Token (`rly_live_...`). */
  token: string;
  /** Signing secret from webhook registration (`whsec_...`). */
  webhookSecret?: string;
  /** Defaults to https://api.relayapp.im */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface RelayPlugin {
  client: RelayClient;
  /**
   * Build the webhook receiver for `message.received` events. Mount it as a
   * POST route; pass `{ waitUntil }` on serverless runtimes that support
   * background work after the response.
   */
  webhook(
    onMessage: WebhookHandler,
    options?: Partial<Omit<WebhookOptions, "client" | "onMessage">>,
  ): ReturnType<typeof createWebhookHandler>;
}

/** One-stop entry: a Relay client plus a signed-webhook receiver factory. */
export function createRelay(options: CreateRelayOptions): RelayPlugin {
  const client = new RelayClient({
    token: options.token,
    baseUrl: options.baseUrl,
    fetch: options.fetch,
  });
  return {
    client,
    webhook(onMessage, overrides) {
      const webhookSecret = overrides?.webhookSecret ?? options.webhookSecret;
      if (!webhookSecret) {
        throw new Error(
          "webhookSecret is required: pass it to createRelay or webhook()",
        );
      }
      return createWebhookHandler({
        client,
        onMessage,
        ...overrides,
        webhookSecret,
      });
    },
  };
}
