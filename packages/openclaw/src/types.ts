import type {
  Chat,
  SelectionReply,
  MessagePartResponse,
  ReplyTo,
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
  selection?: SelectionReply;
  richMessage?: { parts: MessagePartResponse[]; reply_to?: ReplyTo | null };
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
  /**
   * The Message an outbound reply should quote when the person's Message
   * was itself a reply: the person's Message. A tap's reply_to names the
   * agent's buttons part, which no reply may target.
   */
  replyAnchorId?: string;
  /** Whether another agent sent the Message. */
  fromAgent: boolean;
  /**
   * The Message every answer names when another agent sent it: this one,
   * unless it opens with buttons or a selection, which no reply may target.
   */
  agentReplyLink?: string;
  timestamp?: number;
};
