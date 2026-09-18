import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type Chat,
  type Call,
  type CallWebhookEvent,
  type ChatHandle,
  type ChatSendVoicememoResponse,
  type ContactAddedWebhookEvent,
  type ContactRemovedWebhookEvent,
  type DeliveryStatus,
  type Message,
  type MessageContent,
  type MessageCreateResponse,
  type MessageDelivery,
  type MessageFailedWebhook,
  type Reaction,
  type RelayWebhookEnvelope,
  type RelayWebhookEvent,
  type SentMessage,
  type TypingIndicatorWebhookData,
  type TextPartResponse,
  type TextPart,
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
await relay.chats.participants.add("chat-id", { handle: "research" });
await relay.chats.participants.add("chat-id", { handle: "research", hide_history: true });
await relay.chats.participants.add("chat-id", { handle: "research", hide_history: false });
// @ts-expect-error History selection is a boolean, not a string.
await relay.chats.participants.add("chat-id", { handle: "research", hide_history: "false" });
// @ts-expect-error History selection belongs only to addition.
await relay.chats.participants.remove("chat-id", { handle: "research", hide_history: false });
// @ts-expect-error Private chat visibility is not a public API parameter.
await relay.chats.participants.add("chat-id", { handle: "research", is_hidden: true });
// @ts-expect-error Private history boundaries are not public API parameters.
await relay.chats.participants.add("chat-id", { handle: "research", truncated_at: 123 });
// Relay retired message editing and unsending from the developer API.
// @ts-expect-error A Message cannot be edited through the Relay API.
await relay.messages.edit("message-id", { text: "Corrected" });
// @ts-expect-error A Message cannot be unsent through the Relay API.
await relay.messages.unsend("message-id");
// A group photo is set from either form the contract accepts, and cleared with
// null. Neither form is a distinct type: both are plain strings.
await relay.chats.update("chat-id", {
  group_chat_icon: "https://example.com/icon.png",
});
await relay.chats.update("chat-id", {
  group_chat_icon: "018f4b3c-1d2e-7a90-8c5f-6b1d2e3f4a5b",
});
await relay.chats.update("chat-id", { group_chat_icon: null });
// @ts-expect-error A group photo is addressed by ID or HTTPS address, never by bytes.
await relay.chats.update("chat-id", { group_chat_icon: new Uint8Array() });
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
await relay.messages.create({
  to: ["advait"],
  message: {
    parts: [{ type: "text", value: "Hello" }],
    idempotency_key: "message-body-key",
  },
  "Idempotency-Key": "message-header-key",
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
  "message.failed",
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
  "call.created",
  "call.updated",
  "call.ended",
];

// Compile-only provider-neutral call receive and connection exercise.
async function receiveCall(event: CallWebhookEvent): Promise<void> {
  event.data.call satisfies Call;
  if (event.event_type !== "call.created") return;
  await relay.calls.accept(event.data.call.id);
  const { connection } = await relay.calls.connections.create(event.data.call.id, {
    transport: "websocket",
  });
  if (connection.transport === "websocket") {
    connection.audio_format.encoding satisfies "pcm_s16le";
    connection.audio_format.sample_rate satisfies 48000;
    connection.audio_format.channels satisfies 2;
    connection.token satisfies string;
    // @ts-expect-error Vendor credentials are never part of Relay's media grant.
    connection.appSecret;
  }
}
void receiveCall;
await relay.calls.create("chat-id", { to: ["agent"], mode: "audio" }, {
  idempotencyKey: "one-call",
});
// @ts-expect-error Call creation requires a stable idempotency key.
await relay.calls.create("chat-id", { to: ["agent"], mode: "audio" });
// @ts-expect-error Individual Calls have exactly one recipient.
await relay.calls.create("chat-id", { to: ["one", "two"], mode: "audio" }, { idempotencyKey: "one" });
// @ts-expect-error Calls are audio-only.
await relay.calls.create("chat-id", { to: ["agent"], mode: "video" }, { idempotencyKey: "one" });

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
// @ts-expect-error Add requests are gone; the first Message is the request.
relay.contactRequests;
const withService: MessageContent = {
  parts: [{ type: "text", value: "No" }],
  // @ts-expect-error Relay messages have no service discriminator.
  service: "iMessage",
};
void withService;
declare const chat: Chat;
chat.handles[0]!.about satisfies string | null;
// @ts-expect-error The active public Contact shape uses image_url only.
chat.handles[0]!.avatar_url;
// @ts-expect-error The active public Contact shape uses about only.
chat.handles[0]!.tagline;
chat.handles[0]!.verified satisfies boolean;
const userHandle: ChatHandle = {
  id: "user-id",
  handle: "alice",
  joined_at: new Date().toISOString(),
  kind: "user",
  display_name: "Alice",
  image_url: null,
  about: null,
  verified: false,
  is_contact: true,
};
void userHandle;
const agentHandle: ChatHandle = {
  id: "agent-id",
  handle: "echo",
  joined_at: new Date().toISOString(),
  kind: "agent",
  display_name: "Echo",
  image_url: "https://cdn.relayapp.im/echo.png",
  about: "Weather when you need it",
  verified: true,
  is_contact: true,
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

declare const failed: MessageFailedWebhook;
failed.event_type satisfies "message.failed";
failed.data.code satisfies number;
failed.data.failed_at satisfies string;
failed.data.detail_code satisfies number | null | undefined;

// Narrowing on event_type must reach the payload of each new event. Drop a
// branch from RelayWebhookEvent and this stops compiling.
const summarize = (event: RelayWebhookEvent): string => {
  switch (event.event_type) {
    case "message.failed":
      return `${event.data.code} ${event.data.failed_at}`;
    default:
      return event.event_type;
  }
};
void summarize;

declare const message2: Message;
message2.edited_at satisfies string | null | undefined;
message2.unsent_at satisfies string | null | undefined;

// Existing agents retain authenticated deletion; registration is Console-owned.
(await relay.agents.delete("brave_cangoo")) satisfies void;
// @ts-expect-error Anonymous SDK registration has been removed.
Relay.createAgent;
// @ts-expect-error Authenticated instances require an API key.
new Relay({ baseURL: "https://api.example.test" });

// Structured mentions are a read contract, not an outgoing message field.
const readText: TextPartResponse = {
  type: "text", value: "relay", reactions: null,
  mentions: [{ id: "contact-1", handle: "relay", is_me: true, range: [0, 5] }],
};
const readRange: [number, number] | undefined = readText.mentions?.[0]?.range;
const noMentions: TextPartResponse = { ...readText, mentions: null };
const sendText: TextPart = {
  type: "text", value: "relay",
  // @ts-expect-error Structured mentions are only returned on reads.
  mentions: [],
};
void [readRange, noMentions, sendText];

// Button labels are text-only, while tap reply bubbles remain reactable.
const buttonItem: import("@relaymessenger/sdk").ButtonItem = { id: "approve", label: "Approve" };
const removedButtonImage: import("@relaymessenger/sdk").ButtonItem = {
  id: "approve", label: "Approve",
  // @ts-expect-error Button items no longer support images.
  image_url: "https://example.test/icon.png",
};
const buttonsResponse: import("@relaymessenger/sdk").ButtonsPartResponse = {
  type: "buttons", items: [buttonItem], reactions: null,
};
const tapResponse: import("@relaymessenger/sdk").ButtonReplyPartResponse = {
  type: "button_reply", id: "approve", label: "Approve", reactions: [],
};
void [removedButtonImage, buttonsResponse, tapResponse];
