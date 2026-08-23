// The Relay API client the plugin uses. There is no implementation here: this
// is `@relaymessenger/sdk`'s client, vendored under `./vendor/relay-sdk`
// (see that directory's README for why, and for the one-file swap when the
// package ships).
//
// The plugin used to hand-roll its own client beside the SDK's. They drifted,
// and the drift was a defect: the hand-rolled one had no `invocationId` on
// `sendMessage`, `setTyping`, or `setResponding`, so an agent's first group
// mention wedged its entire event stream (REL-167).
import { createRelayClient as createVendoredRelayClient } from "./vendor/relay-sdk/client.js";
import type { RelayClient as VendoredRelayClient } from "./vendor/relay-sdk/client.js";
import type { RelayEventsPage } from "./types.js";

export { DEFAULT_RELAY_BASE_URL, normalizeRelayBaseUrl } from "./vendor/relay-sdk/url.js";
export {
  classifyRelayHttpStatus,
  isAbortError,
  isRelayWebhookConflict,
  RelayApiError,
} from "./vendor/relay-sdk/errors.js";
export type { RelayApiErrorKind } from "./vendor/relay-sdk/errors.js";
export type { RelayClientOptions } from "./vendor/relay-sdk/client.js";
/**
 * A message as the server echoes it back from a send. Distinct from
 * `types.ts`'s `RelayMessage`, which is the inbound shape the plugin renders
 * with its typed parts: a send result is only ever read for its ids.
 */
export type { RelayMessage as RelaySentMessage } from "./vendor/relay-sdk/types.js";

/**
 * The vendored client, restated over the plugin's own event types.
 *
 * The SDK types an event's `data` as an open `Record<string, unknown>`; the
 * plugin types the parts of it that it renders (`message`, its typed parts,
 * `invocation_id`). Both describe the same JSON at different resolutions, and
 * the narrowing happens for real in `buildRelayInboundFacts`, which returns
 * null for anything that does not match. This type only names that boundary —
 * the object is the SDK's, unmodified, at runtime.
 */
export type RelayClient = Omit<VendoredRelayClient, "pollEvents"> & {
  pollEvents: (params: {
    cursor: number;
    timeoutSeconds?: number;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<RelayEventsPage>;
};

export const createRelayClient = createVendoredRelayClient as (
  options: Parameters<typeof createVendoredRelayClient>[0],
) => RelayClient;
