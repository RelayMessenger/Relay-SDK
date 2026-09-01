import type {
  Chat,
  ChatHandle,
  MessageWebhookData,
  Message,
  RelayWebhookEnvelope,
  RelayWebhookEvent,
} from "@relaymessenger/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export type RelayAccountConfig = {
  name?: string;
  enabled?: boolean;
  token?: string;
  tokenFile?: string;
  baseUrl?: string;
  allowFrom?: string[];
};

export type RelayChannelConfig = RelayAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, RelayAccountConfig>;
};

export type RelayCoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    relay?: RelayChannelConfig;
  };
};

export type ResolvedRelayAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  token: string;
  baseUrl: string;
  allowFrom: string[];
  config: RelayAccountConfig;
};

export type RelayIngressPayload = {
  version: 1;
  rawEvent: string;
};

export type RelaySnapshot = {
  version: 1;
  throughSequence: string;
  reason: "checkpoint_outside_retention";
  completedAt: string;
  chats: Array<{
    chat: Chat;
    messages: Message[];
  }>;
};

export type RelayMessageReceivedEvent = RelayWebhookEnvelope<
  MessageWebhookData,
  "message.received"
>;

export type RelayInboundFacts = {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  contactId: string;
  handle: string;
  displayName: string;
  text: string;
  mentionHandles: string[];
  ownerHandle?: ChatHandle;
  replyToId?: string;
  timestamp?: number;
};
