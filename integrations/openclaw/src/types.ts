// Relay wire types plus the plugin's config and resolved-account shapes. The
// receive contract is a plain pull: GET /v1/events?after&timeout&limit ->
// { events, next_cursor, latest, has_more }, and `after` N means "everything
// newer than N". Delivery is at least once and nothing is exclusive, so the
// cursor is a local watermark rather than an acknowledgement handshake.

export type RelaySender = {
  // An actor is a person or an agent. A group's own notices are not authored
  // by the system: "Atlas added June" is a `notice` message sent by Atlas.
  kind: "user" | "agent";
  id: string;
};

// Inline mention of a conversation participant. Offsets are UTF-16 code
// units into the part's text, which holds the inserted display name with
// no "@". Ranges are sorted by start and never overlap.
/**
 * A mention is the handle it names. A sender confirms handles from the
 * client's suggestion list, and the server checks each one is really written
 * as `@handle` in the part's `text`. There are no offsets: a range could mark
 * any word as a mention of anyone, a handle can only ever mark itself.
 */
export type RelayMention = string;

export type RelayTextStyle = "bold" | "italic" | "underline" | "strikethrough";

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
  mentions?: RelayMention[];
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

// A reply is a pointer, never a copy: there is no stored quote to go stale.
// Draw the quote from the target message if this client still holds it.
export type RelayReplyRef = {
  message_id: string;
  part_id?: string;
};

// `notice` is a group notice ("Atlas added June"), carried as a real message
// from the person who caused it. Only `message` starts an agent turn.
export type RelayMessageKind = "message" | "notice";

export type RelayMessage = {
  id: string;
  conversation_id: string;
  sequence: number;
  kind?: RelayMessageKind;
  sender: RelaySender;
  parts: RelayPart[];
  reply_to?: RelayReplyRef | null;
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
  // Pass back as `after` on the next poll.
  nextCursor: number;
  // Highest sequence the server has issued this agent, and whether the page
  // stopped short of it. `hasMore` means poll again without waiting.
  latest: number;
  hasMore: boolean;
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
