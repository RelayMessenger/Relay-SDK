import type {
  Chat,
  Message,
  Relay,
  WebSocketFullSyncContext,
} from "@relaymessenger/sdk";
import { deliveryFromSnapshotMessage } from "./bridge.ts";
import type { AllowedSenders } from "./config.ts";
import type { Redactor } from "./redaction.ts";
import type { RelayStateStore } from "./state.ts";
import type { DeliveryCandidate, RelaySnapshot } from "./types.ts";

type SnapshotClient = Pick<Relay, "chats">;

export async function readCompleteRelaySnapshot(params: {
  readonly relay: SnapshotClient;
  readonly context: WebSocketFullSyncContext;
}): Promise<RelaySnapshot> {
  const chats: Array<{ chat: Chat; messages: Message[] }> = [];
  const seenChats = new Set<string>();
  const seenMessages = new Set<string>();
  const firstChatPage = await params.relay.chats.listChats({ limit: 100 });
  for await (const chat of firstChatPage) {
    if (seenChats.has(chat.id)) throw new Error(`FULL sync returned duplicate Chat ${chat.id}`);
    seenChats.add(chat.id);
    const messages: Message[] = [];
    const firstMessagePage = await params.relay.chats.messages.list(chat.id, { limit: 100 });
    for await (const message of firstMessagePage) {
      if (message.chat_id !== chat.id) {
        throw new Error(
          `FULL sync returned Message ${message.id} under Chat ${chat.id} but its chat_id is ${message.chat_id}`,
        );
      }
      if (seenMessages.has(message.id)) {
        throw new Error(`FULL sync returned duplicate Message ${message.id}`);
      }
      seenMessages.add(message.id);
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

export function reconcileFullSyncDeliveries(params: {
  readonly snapshot: RelaySnapshot;
  readonly allowedSenders: AllowedSenders;
  readonly redactor: Redactor;
}): DeliveryCandidate[] {
  const deliveries: DeliveryCandidate[] = [];
  for (const { chat, messages } of params.snapshot.chats) {
    const agentMessageIds = new Set(
      messages
        .filter((message) => message.is_from_me && !message.is_system_message)
        .map((message) => message.id),
    );
    for (const message of messages) {
      const delivery = deliveryFromSnapshotMessage({
        message,
        chat,
        agentMessageIds,
        throughSequence: params.snapshot.throughSequence,
        allowedSenders: params.allowedSenders,
        redactor: params.redactor,
      });
      if (delivery) deliveries.push(delivery);
    }
  }
  deliveries.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
  return deliveries;
}

export async function commitRelayFullSync(params: {
  readonly relay: SnapshotClient;
  readonly state: RelayStateStore;
  readonly context: WebSocketFullSyncContext;
  readonly allowedSenders: AllowedSenders;
  readonly redactor: Redactor;
}): Promise<void> {
  const snapshot = await readCompleteRelaySnapshot(params);
  const deliveries = reconcileFullSyncDeliveries({
    snapshot,
    allowedSenders: params.allowedSenders,
    redactor: params.redactor,
  });
  params.state.replaceWithFullSync(snapshot, deliveries);
}
