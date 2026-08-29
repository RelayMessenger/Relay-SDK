import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type Chat,
  type ChatSendVoicememoResponse,
  type DeliveryStatus,
  type Message,
  type MessageContent,
  type MessageCreateResponse,
  type Reaction,
  type RelayWebhookEnvelope,
  type SentMessage,
} from "@relayapp/sdk";

const relay = new Relay({
  apiKey: "consumer-token",
  baseURL: "http://127.0.0.1:8790",
});

const content: MessageContent = {
  parts: [{ type: "text", value: "Hello" }],
  idempotency_key: "consumer-key",
};

await relay.chats.messages.send("chat-id", { message: content });
await relay.messages.acknowledgeDelivered("message-id");
await relay.webhookSubscriptions.create({
  target_url: "https://receiver.test/webhook",
  subscribed_events: ["message.received"],
});

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
];

const envelope: RelayWebhookEnvelope = {
  api_version: "v1",
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: "event-id",
  created_at: new Date().toISOString(),
  trace_id: "trace",
  agent_id: "01993d50-b4ce-71e6-8e65-35d325d95dde",
  data: {},
};
void envelope;

// @ts-expect-error Relay has no polling transport.
relay.pollEvents();
// @ts-expect-error Typing no-ops are absent until real transport exists.
relay.chats.typing;
// @ts-expect-error Responding state is not a Relay API.
relay.responding;
// @ts-expect-error The SDK does not expose Linq poll resources.
relay.messages.poll;
const withService: MessageContent = {
  parts: [{ type: "text", value: "No" }],
  // @ts-expect-error Relay messages have no service discriminator.
  service: "iMessage",
};
void withService;
declare const chat: Chat;
// @ts-expect-error Relay does not expose fake archived chat state.
chat.is_archived;
declare const message: Message;
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
