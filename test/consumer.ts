import Relay, {
  selectionPart,
  partsWithSelection,
  type SelectionPartResponse,
  RELAY_WEBHOOK_EVENT_TYPES,
  type AgentCategory,
  type AgentCreator,
  type AgentSkill,
  type AgentVisibility,
  type Chat,
  type ChatActivity,
  type ChatActivityResponse,
  type ChatClearActivityParams,
  type Call,
  type CallMarker,
  type CallWebhookEvent,
  type PaymentRequest,
  type PaymentStatus,
  type LocationFeature,
  type LocationSharingStartedWebhookEvent,
  type ChatHandle,
  type ChatSendVoicememoResponse,
  type ChatSetActivityParams,
  type ContactAddedWebhookEvent,
  type ContactRemovedWebhookEvent,
  type ContactLookup,
  type ContactLookupResponse,
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
  type SystemEventType,
  type TypingIndicatorWebhookData,
  type TextPartResponse,
  type TextPart,
  type WebSocketDisconnectFrame,
} from "@relaymessenger/sdk";

const relay = new Relay({
  apiKey: "consumer-token",
  baseURL: "http://127.0.0.1:8790",
});

// Source-consumer example, not a claim about a published version.
const topics = selectionPart([
  { value: "research", label: "Research" },
  { value: "design", label: "Design" },
]);
if (typeof topics === "string") throw new Error(topics);
const selectionMessage: MessageContent = {
  parts: partsWithSelection("Which topics?", topics),
  idempotency_key: "selection-prompt-operation",
};
await relay.chats.messages.send("chat-id", { message: selectionMessage });
const viewerSelection: SelectionPartResponse = {
  ...topics, has_responded: false, selected_values: null, reactions: null,
};
// @ts-expect-error Viewer state is read-only.
viewerSelection.has_responded = true;
// @ts-expect-error The viewer's answer is read-only.
viewerSelection.selected_values = ["research"];
const selectionEvent = relay.webhooks.unwrap("{}", { headers: {} });
if (selectionEvent.event_type === "message.received") {
  const values: string[] | undefined = selectionEvent.data.parts
    .find((part) => part.type === "selection_response")?.selected_values;
  const source: string | undefined = selectionEvent.data.reply_to?.message_id;
  void [values, source];
}
const liveCallMarker: CallMarker = {
  id: "call-id", status: "ringing",
  answered_at: null, ended_at: null,
  from: { id: "caller-id", handle: "caller", kind: "agent" },
  to: [{ id: "callee-id", handle: "callee", kind: "user" }],
  duration_seconds: null,
};
liveCallMarker.status satisfies Call["status"];
const callEvent: SystemEventType = "call";
// @ts-expect-error A call marker represents the whole call, not only its end.
const retiredCallEvent: SystemEventType = "call_ended";
void [liveCallMarker, callEvent, retiredCallEvent];

const content: MessageContent = {
  parts: [{ type: "text", value: "Hello" }],
  idempotency_key: "consumer-key",
};

await relay.chats.messages.send("chat-id", { message: content });
await relay.chats.shareContactCard("chat-id");
await relay.chats.startTyping("chat-id");
await relay.chats.stopTyping("chat-id");
const activityParams: ChatSetActivityParams = { text: "Generating image", emoji: "🖼️" };
const activityState: ChatActivityResponse = await relay.chats.setActivity("chat-id", activityParams);
activityState.version satisfies string;
activityState.activity satisfies ChatActivity | null;
await relay.chats.getActivity("chat-id") satisfies ChatActivityResponse;
await relay.chats.setActivity("chat-id", { text: "Working", activity_id: "activity-id", emoji: null });
const clearActivityParams: ChatClearActivityParams = { activity_id: "activity-id" };
await relay.chats.clearActivity("chat-id", clearActivityParams) satisfies void;
await relay.chats.clearActivity("chat-id");
// @ts-expect-error Activity text is required.
await relay.chats.setActivity("chat-id", { emoji: "🖼️" });
// @ts-expect-error An activity guard is a UUID string, not a number.
await relay.chats.clearActivity("chat-id", { activity_id: 1 });
// @ts-expect-error Activity is not an agent webhook event.
const activityEvent: typeof RELAY_WEBHOOK_EVENT_TYPES[number] = "chat.activity.updated";
void activityEvent;
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
  onEvent: async (event, context) => {
    if (event.event_type === "message.received") {
      const selected: string[] | undefined = event.data.parts
        .find((part) => part.type === "selection_response")?.selected_values;
      void selected;
    }
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
  "payment.succeeded",
  "payment.canceled",
  "payment.expired",
  "location.sharing.started",
  "location.sharing.stopped",
];

// Compile-only payment request exercise: create, then send its checkout_url.
async function requestPayment(chatId: string): Promise<void> {
  const request = await relay.paymentRequests.create(
    { amount: 2400, currency: "usd", description: "House blend, 250 g", category: "physical_goods" },
    { idempotencyKey: "order-42" },
  );
  request.checkout_url satisfies string;
  await relay.chats.messages.send(chatId, {
    message: { parts: [{ type: "payment", checkout_url: request.checkout_url }] },
  });
  (await relay.paymentRequests.list({ status: "requested" })).payment_requests satisfies PaymentRequest[];
  (await relay.paymentRequests.cancel(request.id)).status satisfies PaymentStatus;
}
void requestPayment;

// Compile-only location exercise: ask, then read once the person shares.
async function readLocation(event: LocationSharingStartedWebhookEvent): Promise<void> {
  event.data.ends_at satisfies string | null;
  (await relay.chats.location.request(event.data.chat_id)).message satisfies "Location request sent";
  const read = await relay.chats.location.retrieve(event.data.chat_id);
  read.data.features satisfies LocationFeature[];
  read.data.features[0]?.geometry.coordinates satisfies [number, number] | undefined;
}
void readLocation;

// Compile-only call event and REST exercise.
async function receiveCall(event: CallWebhookEvent): Promise<void> {
  event.data.call satisfies Call;
  await relay.calls.list(event.data.call.chat_id);
  await relay.calls.retrieve(event.data.call.id);
  await relay.calls.end(event.data.call.id);
}
void receiveCall;
await relay.calls.create("chat-id", { to: ["agent"] }, {
  idempotencyKey: "one-call",
});
// @ts-expect-error Call creation requires a stable idempotency key.
await relay.calls.create("chat-id", { to: ["agent"] });
// @ts-expect-error Individual Calls have exactly one recipient.
await relay.calls.create("chat-id", { to: ["one", "two"] }, { idempotencyKey: "one" });
// @ts-expect-error Call creation takes only the recipient; Relay rejects any other key.
await relay.calls.create("chat-id", { to: ["agent"], mode: "audio" }, { idempotencyKey: "one" });

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
// @ts-expect-error Person settings remain outside the public SDK contract.
relay.me;
// @ts-expect-error The public Contact Card update has no agent admission field.
await relay.contactCard.update({ handle: "echo", message_requests_from: "everyone" });
// @ts-expect-error The public Contact Card create request has no agent admission field.
await relay.contactCard.create({ handle: "echo", first_name: "Echo", message_requests_from: "everyone" });
const ownCards = await relay.contactCard.retrieve({ handle: "echo" });
// @ts-expect-error The public Contact Card response has no agent admission field.
ownCards.contact_cards[0]!.message_requests_from;
const lookup: ContactLookupResponse = await relay.contacts.lookup({ handle: "alice" });
if (!("contact" in lookup)) throw new Error("A Handle lookup answers with one contact.");
lookup.contact.kind satisfies "user" | "agent";
lookup.contact.image_color satisfies string | null;
lookup.contact.subtitle satisfies string | null | undefined;
const byTask: ContactLookupResponse = await relay.contacts.lookup({ task: "book a flight" });
if (!("contacts" in byTask)) throw new Error("A task search answers with a list.");
byTask.contacts satisfies ContactLookup[];
byTask.contacts[0]?.skills satisfies AgentSkill[] | undefined;
byTask.contacts[0]?.category satisfies AgentCategory | null | undefined;
byTask.contacts[0]?.visibility satisfies AgentVisibility | undefined;
byTask.contacts[0]?.creator satisfies AgentCreator | null | undefined;
ownCards.contact_cards[0]!.is_verified satisfies boolean | undefined;
// @ts-expect-error Public lookup does not carry person settings or an agent admission field.
lookup.contact.message_requests_from;
// @ts-expect-error Lookup requires a Handle or a task.
await relay.contacts.lookup({});
// @ts-expect-error Private Contact writes are not public SDK operations.
relay.contacts.add;
// @ts-expect-error Private Contact writes are not public SDK operations.
relay.contacts.remove;
// @ts-expect-error Private Contact lists are not public SDK operations.
relay.contacts.list;
// @ts-expect-error Request lifecycle state is private.
lookup.contact.is_request;
// @ts-expect-error Request expiry is private.
lookup.contact.request_expires_at;
// @ts-expect-error Request sender identity is private.
lookup.contact.request_sender_id;
// @ts-expect-error Add requests are gone; the first Message is the request.
relay.contactRequests;
const withService: MessageContent = {
  parts: [{ type: "text", value: "No" }],
  // @ts-expect-error Relay messages have no service discriminator.
  service: "iMessage",
};
void withService;
declare const chat: Chat;
// @ts-expect-error Request lifecycle state belongs to the private client projection.
chat.is_request;
// @ts-expect-error Request expiry belongs to the private client projection.
chat.request_expires_at;
// @ts-expect-error Request sender identity belongs to the private client projection.
chat.request_sender_id;
chat.handles[0]!.subtitle satisfies string | null;
// @ts-expect-error The active public Contact shape uses image_url only.
chat.handles[0]!.avatar_url;
// @ts-expect-error The active public Contact shape uses subtitle only.
chat.handles[0]!.tagline;
chat.handles[0]!.verified satisfies boolean;
const userHandle: ChatHandle = {
  id: "user-id",
  handle: "alice",
  joined_at: new Date().toISOString(),
  kind: "user",
  display_name: "Alice",
  image_url: null,
  subtitle: null,
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
  subtitle: "Weather when you need it",
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

// Button items are a label and an optional url; a tap is an ordinary text reply.
const buttonItem: import("@relaymessenger/sdk").ButtonItem = { label: "Approve" };
const linkItem: import("@relaymessenger/sdk").ButtonItem = { url: "https://example.test", label: "Open" };
const removedButtonId: import("@relaymessenger/sdk").ButtonItem = {
  label: "Approve",
  // @ts-expect-error Button items carry no id; the tap sends the label.
  id: "approve",
};
const removedButtonImage: import("@relaymessenger/sdk").ButtonItem = {
  label: "Approve",
  // @ts-expect-error Button items no longer support images.
  image_url: "https://example.test/icon.png",
};
const buttonsResponse: import("@relaymessenger/sdk").ButtonsPartResponse = {
  type: "buttons", items: [buttonItem, linkItem], reactions: null,
};
const tap: import("@relaymessenger/sdk").MessageContent = {
  parts: [{ type: "text", value: "Approve" }],
  reply_to: { message_id: "message-id", part_index: 1 },
};
void [removedButtonId, removedButtonImage, buttonsResponse, tap];
