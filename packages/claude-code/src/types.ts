import type {
  Chat,
  Message,
  RelayWebhookEvent,
  WebSocketFullSyncContext,
} from "@relaymessenger/sdk";

/** `completed` and `failed` are the model's own decisions and are final.
 * `expired`, `superseded`, and `interrupted` (the channel process was
 * replaced or stopped mid-turn) leave the Message unanswered, so the delivery
 * returns to the inbox. */
export type TurnOutcome = "completed" | "failed" | "expired" | "superseded" | "interrupted";

export interface TurnOrigin {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly senderHandle: string;
}

export interface DeliveryCandidate {
  readonly deliveryId: string;
  readonly eventId: string | null;
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly senderHandle: string;
  readonly content: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface StoredDelivery extends DeliveryCandidate {
  readonly status: "pending" | "starting" | "processing";
  readonly lastNotifiedAt: number | null;
  readonly processingStartedAt: number | null;
  readonly readMarkedAt: number | null;
}

export interface StoredIngressEvent {
  readonly sequence: string;
  readonly event: RelayWebhookEvent;
}

export interface OutboundRegistration {
  readonly idempotencyKey: string;
  readonly confirmed: boolean;
}

export interface RelaySnapshot {
  readonly version: 1;
  readonly throughSequence: string;
  readonly reason: WebSocketFullSyncContext["reason"];
  readonly completedAt: string;
  readonly chats: ReadonlyArray<{
    readonly chat: Chat;
    readonly messages: readonly Message[];
  }>;
}
