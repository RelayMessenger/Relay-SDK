import type {
  Chat,
  Message,
  Relay,
  WebSocketFullSyncContext,
} from "@relaymessenger/sdk";
import type {
  RelaySnapshot,
} from "./types.js";
import type { RelayStateStore } from "./state.js";

type RelaySnapshotClient = Pick<Relay, "chats">;

export async function readCompleteRelaySnapshot(params: {
  relay: RelaySnapshotClient;
  context: WebSocketFullSyncContext;
}): Promise<RelaySnapshot> {
  const chats: Array<{ chat: Chat; messages: Message[] }> = [];
  const firstChatPage = await params.relay.chats.listChats({ limit: 100 });
  for await (const chat of firstChatPage) {
    const messages: Message[] = [];
    const firstMessagePage = await params.relay.chats.messages.list(
      chat.id,
      { limit: 100 },
    );
    for await (const message of firstMessagePage) {
      messages.push(message);
    }
    chats.push({ chat, messages });
  }
  return {
    version: 1,
    throughSequence: params.context.throughSequence,
    reason: params.context.reason,
    completedAt: new Date().toISOString(),
    chats,
  };
}

export async function commitRelayFullSync(params: {
  relay: RelaySnapshotClient;
  state: RelayStateStore;
  context: WebSocketFullSyncContext;
}): Promise<void> {
  const snapshot = await readCompleteRelaySnapshot(params);
  await params.state.replaceSnapshot(snapshot);
}
