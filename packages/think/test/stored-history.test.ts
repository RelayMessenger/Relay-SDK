import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { describe, expect, it } from "vitest";
import { relayTurnMetadata } from "../src/stored-history";

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const ATTACHMENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const QUOTED_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";

const webhookMessage = {
  id: MESSAGE_ID,
  chat: { id: CHAT_ID, is_group: false },
  direction: "inbound",
  sent_at: "2026-10-07T12:00:00.000Z",
  sender_handle: {
    id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
    handle: "advait",
    display_name: "Advait",
    joined_at: "2026-08-29T00:00:00Z",
    kind: "user",
  },
  reply_to: { message_id: QUOTED_ID, part_index: 0 },
  thread: { originator_message_id: QUOTED_ID, originator_part_index: 0 },
  parts: [
    { type: "text", value: "look at this" },
    {
      type: "media",
      id: ATTACHMENT_ID,
      url: "https://cdn.relayapp.im/sealed/abc",
      filename: "photo.jpg",
      mime_type: "image/jpeg",
      size_bytes: 1234,
    },
  ],
};

const expected = {
  message: {
    id: MESSAGE_ID,
    sent_at: "2026-10-07T12:00:00.000Z",
    sender_handle: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
      handle: "advait",
      display_name: "Advait",
      kind: "user",
    },
    reply_to: { message_id: QUOTED_ID, part_index: 0 },
    thread: { originator_message_id: QUOTED_ID, originator_part_index: 0 },
    attachments: [{
      id: ATTACHMENT_ID,
      filename: "photo.jpg",
      mime_type: "image/jpeg",
      size_bytes: 1234,
    }],
  },
};

/** The messenger context Think hands the turn, built by the installed Think. */
async function thinkMessengerContext(): Promise<unknown> {
  const { messengerContextFromEvent, toMessengerMessage } = await import(
    "@cloudflare/think/messengers"
  );
  const adapter = createRelayAdapter({
    token: "relay-test-token",
    webhookSecret: "whsec_dGVzdA==",
    baseUrl: "https://api.staging.relayapp.im",
    userName: "relay",
  });
  const message = adapter.parseMessage({
    chatId: CHAT_ID,
    eventType: "message.received",
    message: webhookMessage,
  } as never);
  return messengerContextFromEvent({
    capabilities: {},
    kind: "direct-message",
    messengerId: "relay",
    provider: "relay",
    thread: { channelId: "relay", id: `relay:${CHAT_ID}`, providerThreadId: `relay:${CHAT_ID}` },
    message: toMessengerMessage(message as never),
  } as never);
}

describe("relayTurnMetadata", () => {
  it("keeps Relay's facts about a person's Message from the verified webhook", async () => {
    const context = await thinkMessengerContext();
    expect(relayTurnMetadata(context, webhookMessage)).toEqual(expected);
  });

  it("keeps the sender kind and attachments from Think's own messenger context", async () => {
    const context = await thinkMessengerContext();
    const { reply_to: _reply, thread: _thread, ...withoutWebhookOnly } = expected.message;
    expect(relayTurnMetadata(context)).toMatchObject({
      message: { ...withoutWebhookOnly, sent_at: expect.any(String) },
    });
  });

  it("returns nothing without a messenger message", () => {
    expect(relayTurnMetadata(undefined, webhookMessage)).toBeUndefined();
  });
});
