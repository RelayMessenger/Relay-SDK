import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type Chat,
  type ChatHandle,
  type ChatSendVoicememoResponse,
  type ContactAddedWebhookEvent,
  type ContactRemovedWebhookEvent,
  type DeliveryStatus,
  type Message,
  type MessageContent,
  type MessageCreateResponse,
  type MessageDelivery,
  type Reaction,
  type RelayWebhookEnvelope,
  type SentMessage,
  type TypingIndicatorWebhookData,
  type WebSocketDisconnectFrame,
} from "@relaymessenger/sdk";

const relay = new Relay({
  apiKey: "consumer-token",
  baseURL: "http://127.0.0.1:8790",
});

const content: MessageContent = {
  parts: [{ type: "text", value: "Hello" }],
  idempotency_key: "consumer-key",
};

await relay.chats.messages.send("chat-id", { message: content });
await relay.chats.shareContactCard("chat-id");
await relay.chats.startTyping("chat-id");
await relay.chats.stopTyping("chat-id");
await relay.chats.markAsRead("chat-id");
void relay.websocket.run({
  onEvent: async (_event, context) => {
    context.sequence satisfies string;
    // @ts-expect-error WebSocket transport ACK context has no Read control.
    context.markAsRead("chat-id");
  },
  onFullSync: async ({ throughSequence, reason }) => {
    throughSequence satisfies string;
    reason satisfies "checkpoint_outside_retention";
  },
});
// @ts-expect-error FULL sync handling is required for durable WebSocket recovery.
void relay.websocket.run({ onEvent: async () => {} });
// @ts-expect-error Direct WebSocket auth replaced connection-ticket creation.
relay.websocket.createConnection;
// @ts-expect-error WebSocket delivery is selected by Webhook configuration.
relay.websocket.retrieve;
// @ts-expect-error Relay has no WebSocket mode or enable toggle.
relay.websocket.update;
const reconnect: WebSocketDisconnectFrame = {
  type: "disconnect",
  reason: "heartbeat_timeout",
};
void reconnect;
await relay.webhookSubscriptions.create({
  target_url: "https://receiver.test/webhook",
  subscribed_events: ["message.received"],
});
const addRequest = await relay.contactRequests.create({
  handle: "advait",
  "Idempotency-Key": "contact-request-key",
});
addRequest.state satisfies "pending";

const page = await relay.chats.listChats();
page.chats satisfies Chat[];
page.hasNextPage() satisfies boolean;
for await (const chat of page) {
  chat.id satisfies string;
}

RELAY_WEBHOOK_EVENT_TYPES satisfies readonly [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "reaction.added",
  "reaction.removed",
  "participant.added",
  "participant.removed",
  "chat.created",
  "chat.group_name_updated",
  "chat.group_icon_updated",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
  "contact.added",
  "contact.removed",
];

const envelope: RelayWebhookEnvelope = {
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: "message.received",
  event_id: "event-id",
  created_at: new Date().toISOString(),
  trace_id: "trace",
  agent_id: "01993d50-b4ce-71e6-8e65-35d325d95dde",
  data: {},
};
void envelope;

const typingData: TypingIndicatorWebhookData = {
  chat_id: "01993d50-b4ce-71e6-8e65-35d325d95ddc",
  contact: {
    id: "01993d50-b4ce-71e6-8e65-35d325d95dde",
    handle: "alice",
    kind: "user",
  },
};
typingData.contact.handle satisfies string;

// @ts-expect-error Relay has no polling transport.
relay.pollEvents();
// @ts-expect-error Typing is exposed as real start/stop commands, not a fake resource.
relay.chats.typing;
// @ts-expect-error Responding state is not a Relay API.
relay.responding;
// @ts-expect-error The SDK does not expose Linq poll resources.
relay.messages.poll;
// @ts-expect-error Socket Mode is not Relay vocabulary.
relay.socketMode;
// @ts-expect-error Private user Contact operations are not in the Agent SDK.
relay.contacts;
// @ts-expect-error The Agent SDK cannot list private user Contact requests.
relay.contactRequests.list();
// @ts-expect-error The Agent SDK cannot ignore private user Contact requests.
relay.contactRequests.ignore({ handle: "echo" });
const withService: MessageContent = {
  parts: [{ type: "text", value: "No" }],
  // @ts-expect-error Relay messages have no service discriminator.
  service: "iMessage",
};
void withService;
declare const chat: Chat;
chat.handles[0]!.tagline satisfies string | null;
chat.handles[0]!.verified satisfies boolean;
const userHandle: ChatHandle = {
  id: "user-id",
  handle: "alice",
  joined_at: new Date().toISOString(),
  kind: "user",
  display_name: "Alice",
  avatar_url: null,
  tagline: null,
  verified: false,
};
void userHandle;
const agentHandle: ChatHandle = {
  id: "agent-id",
  handle: "echo",
  joined_at: new Date().toISOString(),
  kind: "agent",
  display_name: "Echo",
  avatar_url: "https://cdn.relayapp.im/echo.png",
  tagline: "Weather when you need it",
  verified: true,
};
void agentHandle;
// @ts-expect-error Greetings are not part of Relay Add.
agentHandle.greeting_message;
// @ts-expect-error Premium-handle state is private.
agentHandle.is_premium_handle;
// @ts-expect-error Relay does not expose fake archived chat state.
chat.is_archived;
declare const message: Message;
(message.deliveries ?? []) satisfies MessageDelivery[];
// @ts-expect-error Reconciliation bookkeeping is not a message field.
message.reconciled_at;
declare const sendResult: MessageCreateResponse;
// @ts-expect-error Relay has no carrier selection result.
sendResult.from_selection;
declare const voiceResult: ChatSendVoicememoResponse;
// @ts-expect-error Voice chat projection has no fake active constant.
voiceResult.voice_memo.chat.is_active;
declare const reaction: Reaction;
// @ts-expect-error Stickers are outside Relay v1.
reaction.sticker;
declare const sent: SentMessage;
// @ts-expect-error Message effects are outside Relay v1.
sent.effect;
// @ts-expect-error Failed is not a current delivery state.
const failedStatus: DeliveryStatus = "failed";
void failedStatus;
// @ts-expect-error Webhook envelopes are Relay v1.
const oldEnvelope: RelayWebhookEnvelope = { ...envelope, api_version: "v3" };
void oldEnvelope;
const oldWebhookEnvelope: RelayWebhookEnvelope = {
  ...envelope,
  // @ts-expect-error Relay uses only the 2026-08-30 Webhook contract.
  webhook_version: "2026-08-29",
};
void oldWebhookEnvelope;

declare const added: ContactAddedWebhookEvent;
added.event_type satisfies "contact.added";
added.data.contact.display_name satisfies string;
added.data.chat_id satisfies string;

declare const removed: ContactRemovedWebhookEvent;
removed.event_type satisfies "contact.removed";
removed.data.contact.handle satisfies string;
// @ts-expect-error contact.removed does not disclose a Chat ID.
removed.data.chat_id;
