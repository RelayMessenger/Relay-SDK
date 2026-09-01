import type {
  RelayWebhookEvent,
  WebSocketFullSyncContext,
  WebSocketRunOptions,
} from "@relaymessenger/sdk";

import {
  loadCompleteRelayState,
  type RelaySnapshotSource,
} from "./snapshot.js";
import type { RelayStore } from "./store.js";

export function createSocketCallbacks(
  relay: RelaySnapshotSource,
  store: Pick<RelayStore, "accept" | "replaceSnapshot">,
  wake: () => void,
): Pick<WebSocketRunOptions, "onEvent" | "onFullSync"> {
  return {
    async onEvent(
      event: RelayWebhookEvent,
      { sequence }: { sequence: string },
    ): Promise<void> {
      const inserted = store.accept(event, sequence);
      if (inserted) wake();
    },
    async onFullSync(context: WebSocketFullSyncContext): Promise<void> {
      const snapshot = await loadCompleteRelayState(relay);
      store.replaceSnapshot(snapshot, context);
    },
  };
}
