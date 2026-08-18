/** Wire types for the Relay v1 developer API used by plugins and examples. */

export type RelaySender = {
  kind: "user" | "agent" | "system";
  id: string;
  display_name?: string;
};

export type RelayOutgoingPart =
  | { type: "text"; text: string }
  | { type: "media"; attachment_id?: string; url?: string }
  | { type: "voice_memo"; attachment_id?: string; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string }
  | { type: "data"; data: Record<string, unknown> };

export type RelayPart = {
  type: string;
  part_index?: number;
  text?: string;
  url?: string;
  attachment_id?: string;
  duration_ms?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RelayReplyRef = {
  message_id: string;
  part_index?: number;
};

export type RelayMessage = {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: RelaySender;
  parts: RelayPart[];
  reply_to?: RelayReplyRef | null;
  fallback_text?: string;
  status?: string;
  created_at: string;
};

export type RelayEventEnvelope<TData = Record<string, unknown>> = {
  event_id: string;
  event_type: string;
  agent_id: string;
  created_at: string;
  data: TData;
};

export type MessageReceivedData = {
  message: RelayMessage;
  invocation_id?: string;
};

export type MessageReceivedEvent = RelayEventEnvelope<MessageReceivedData>;

export type RelayAgentProfile = {
  id: string;
  owner_user_id?: string;
  handle: string;
  display_name: string;
  tagline?: string;
  avatar_url?: string | null;
  visibility?: "private" | "unlisted" | "public";
  created_at?: string;
};

export type RelayEventsPage = {
  events: RelayEventEnvelope[];
  nextCursor: number;
};

export type RelaySendResult = {
  messageId: string;
  message: RelayMessage;
};
