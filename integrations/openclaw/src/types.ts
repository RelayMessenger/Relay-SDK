// Relay wire types plus the plugin's config and resolved-account shapes. The
// long-poll receive contract is GET /v1/events?cursor&timeout&limit ->
// { events, next_cursor }, cursor N acknowledges everything <= N.

export type RelaySender = {
  // `system` is real on the wire: a group's own notices are authored by it
  // (creating a group commits "<name> created <title>"). Only `user` messages
  // start a turn, and `buildRelayInboundFacts` drops everything else.
  kind: "user" | "agent" | "system";
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
  part_index?: number;
  type: "text";
  text: string;
  mentions?: RelayMentionRange[];
  styles?: RelayStyleRange[];
};

export type RelayMediaPart = {
  part_index?: number;
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
  part_index?: number;
  type: "voice_memo";
  url: string;
  attachment_id?: string;
  duration_ms?: number;
};

export type RelayLinkPreviewPart = {
  part_index?: number;
  type: "link_preview";
  url: string;
};

export type RelayDataPart = {
  part_index?: number;
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
    /**
     * Present only when this event belongs to a group invocation: a human
     * mentioned the agent, replied to it, or picked it. In a group the server
     * delivers nothing to an agent that was not invoked, and every call the
     * agent then makes about the message must carry this id back
     * (`/typing`, `/responding`, and the reply itself all refuse without it).
     * A direct message never carries one — the server rejects
     * `invoked_agent_ids` outside a group — so its presence is also how the
     * plugin knows it is in a group.
     */
    invocation_id?: string;
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

// The 202 from POST /v1/messages. The server splits the accepted parts at
// ingest: each visible non-media part becomes its own message, contiguous
// media parts stay one media message, and a voice memo always commits alone,
// so one send commits one or more messages, in display order.
export type RelaySendResult = {
  messages: RelayMessage[];
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
