import type {
  RelayWebhookEvent,
  WebSocketFullSyncContext,
  WebSocketRunOptions,
} from "@relaymessenger/sdk";

import {
  loadRememberedThreads,
  type RelaySnapshotSource,
} from "./snapshot.js";
import type { TripStore } from "./store.js";

/**
 * The SDK acknowledges only after `onEvent` resolves, so the event is on
 * disk before Relay is told it arrived, and only after `onFullSync`
 * resolves, so a rebuilt transcript is committed before the stream resumes.
 */
export function createSocketCallbacks(
  relay: RelaySnapshotSource,
  store: Pick<TripStore, "accept" | "replaceThreads">,
  wake: () => void,
): Pick<WebSocketRunOptions, "onEvent" | "onFullSync"> {
  return {
    async onEvent(
      event: RelayWebhookEvent,
      { sequence }: { sequence: string },
    ): Promise<void> {
      if (store.accept(event, sequence)) wake();
    },
    async onFullSync(context: WebSocketFullSyncContext): Promise<void> {
      store.replaceThreads(await loadRememberedThreads(relay), context);
    },
  };
}
