// Relay wire types plus the plugin's config and resolved-account shapes. The
// long-poll receive contract is GET /v1/events?cursor&timeout&limit ->
// { events, next_cursor }, cursor N acknowledges everything <= N.

export type RelaySender = {
  kind: "user" | "agent";
  id: string;
};

// Inline mention of a conversation participant. Offsets are UTF-16 code
// units into the part's text, which holds the inserted display name with
// no "@". Ranges are sorted by start and never overlap.
export type RelayMentionRange = {
  start: number;
  length: number;
  participant_id: string;
};

export type RelayTextStyle = "bold" | "italic" | "underline" | "strikethrough" | "monospace" | "spoiler";

// One formatting run over a text part, offsets in UTF-16 code units like
// mentions. An EMPTY styles array on the part is meaningful: it marks
// structured plain text as opposed to a legacy Markdown body.
export type RelayStyleRange = {
  start: number;
  length: number;
  styles: RelayTextStyle[];
};

export type RelayTextPart = {
  part_index: number;
  type: "text";
  text: string;
  mentions?: RelayMentionRange[];
  styles?: RelayStyleRange[];
};

export type RelayMediaPart = {
  part_index: number;
  type: "media";
  url: string;
  attachment_id?: string;
  // Pixel dimensions (always paired) and a blurhash placeholder (base83)
  // to draw before the bytes download.
  width?: number;
  height?: number;
  blur_hash?: string;
};

export type RelayVoiceMemoPart = {
  part_index: number;
  type: "voice_memo";
  url: string;
  attachment_id?: string;
  duration_ms?: number;
};

export type RelayLinkPreviewPart = {
  part_index: number;
  type: "link_preview";
  url: string;
};

export type RelayDataPart = {
  part_index: number;
  type: "data";
  data: unknown;
};

export type RelayPart =
  | RelayTextPart
  | RelayMediaPart
  | RelayVoiceMemoPart
  | RelayLinkPreviewPart
  | RelayDataPart;

export type RelayReplyRef = {
  message_id?: string;
  part_index?: number;
} | null;

export type RelayMessage = {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: RelaySender;
  parts: RelayPart[];
  reply_to?: RelayReplyRef;
  fallback_text: string;
  status: string;
  created_at: string;
};

export type RelayEventType =
  | "message.received"
  | "reaction.added"
  | "reaction.removed"
  | "message.delivered"
  | "message.read"
  | (string & {});

export type RelayEvent = {
  event_id: string;
  event_type: RelayEventType;
  agent_id: string;
  created_at: string;
  data: {
    message?: RelayMessage;
    [key: string]: unknown;
  };
};

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
  events: RelayEvent[];
  nextCursor: number;
};

export type RelaySendResult = {
  messageId: string;
  message: RelayMessage;
};

// ---------------------------------------------------------------------------
// Plugin config (channels.relay) and resolved account.
// ---------------------------------------------------------------------------

export type RelayAccountConfig = {
  name?: string;
  enabled?: boolean;
  token?: string;
  tokenFile?: string;
  baseUrl?: string;
  allowFrom?: Array<string | number>;
  pollTimeoutSeconds?: number;
};

export type RelayChannelConfig = RelayAccountConfig & {
  accounts?: Record<string, Partial<RelayAccountConfig>>;
  defaultAccount?: string;
};

export type RelayCoreConfig = {
  channels?: {
    relay?: RelayChannelConfig;
  };
  session?: {
    store?: string;
  };
};

export type ResolvedRelayAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  token: string;
  baseUrl: string;
  pollTimeoutSeconds: number;
  config: RelayAccountConfig;
};
