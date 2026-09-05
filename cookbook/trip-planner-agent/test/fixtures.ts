import type {
  MessageWebhookData,
  RelayWebhookEnvelope,
} from "@relaymessenger/sdk";

import type { TripPlan } from "../src/plan.js";

export const AGENT_HANDLE = {
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec20",
  handle: "tripplanner",
  kind: "agent" as const,
  joined_at: "2026-09-03T12:00:00Z",
  display_name: "Trip planner",
  image_url: null,
  about: null,
  verified: false,
  is_me: true,
};

export const ALICE = {
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec21",
  handle: "alice",
  kind: "user" as const,
  joined_at: "2026-09-03T12:00:00Z",
  display_name: "Alice",
  image_url: null,
  about: null,
  verified: false,
};

/**
 * A Chat holds one person and one or more agents, so the other participant in
 * the group is an agent too: the one that reads the person's calendar.
 */
export const CALENDAR_AGENT = {
  ...ALICE,
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec22",
  handle: "calendar",
  kind: "agent" as const,
  display_name: "Calendar",
};

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec30";

interface EventOptions {
  eventId: string;
  isGroup: boolean;
  mention?: string | undefined;
  messageId: string;
  sender?: typeof ALICE | typeof CALENDAR_AGENT;
  text: string;
}

export type InboundMessageEvent = RelayWebhookEnvelope<
  MessageWebhookData,
  "message.received"
>;

export function inboundEvent({
  eventId,
  isGroup,
  mention,
  messageId,
  sender = ALICE,
  text,
}: EventOptions): InboundMessageEvent {
  const data: MessageWebhookData = {
    chat: isGroup
      ? { id: CHAT_ID, is_group: true, owner_handle: AGENT_HANDLE }
      : { id: CHAT_ID, is_group: false },
    id: messageId,
    direction: "inbound",
    sender_handle: sender,
    parts: [
      mention === undefined
        ? { type: "text", value: text, reactions: null }
        : {
          type: "text",
          value: text,
          mention,
          mention_range: [0, mention.length],
          reactions: null,
        },
    ],
  };
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: eventId,
    created_at: "2026-09-03T12:00:00Z",
    trace_id: "trace",
    agent_id: "01993d50-ef7b-7b37-886b-23fd80c7ec19",
    data,
  };
}

export const CHAT = CHAT_ID;

export function inboundMessage(options: EventOptions): MessageWebhookData {
  return inboundEvent(options).data;
}

export const PLAN: TripPlan = {
  destination: "Lisbon",
  dates: "12-14 June",
  travelers: ["Alice"],
  budget: "800 euro",
  days: [{ label: "Day 1 - Friday", items: ["Land at midday", "Walk Alfama"] }],
  open_questions: [],
};
