/**
 * Wire types for the Relay developer API.
 *
 * Derived field for field from `schemas/message-v2.schema.json`, which
 * Relay-Server owns and generates from real server responses. The copy in this
 * package is byte-identical to that file, and
 * `scripts/check-types-against-schema.mjs` fails `npm run check` when a
 * property in the schema has no counterpart here. Add a field to the schema
 * first; this file follows it.
 *
 * Two rules run through every type below, and both exist so an old client
 * degrades instead of breaking:
 *
 *  - **Unknown part types are data, not errors.** `RelayPart["type"]` is
 *    `string`, and `isKnownPartKind` is how you narrow. A part you do not
 *    recognise still has an identity and still belongs in the message; render
 *    the message's `fallback_text` for it.
 *  - **Additive fields never break.** Every wire object carries an index
 *    signature, because Relay adds optional members without a version bump.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** `<prefix>_<26-char lowercase Crockford ULID>`. Well-formed proves nothing else. */
export type RelayId = string;

/**
 * Anyone who can act in a conversation. There is no `system` actor: a group
 * notice is sent by the person who caused it.
 */
export type RelayActor = {
  kind: "user" | "agent";
  id: RelayId;
  [key: string]: unknown;
};

/** The `sender` of a message is an actor. */
export type RelaySender = RelayActor;

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * A mention is the handle it names. A sender confirms handles from the
 * client's suggestion list, and the server checks each one is really written
 * as `@handle` in the part's `text`. There are no offsets: a range could mark
 * any word as a mention of anyone, a handle can only ever mark itself.
 */
export type RelayMention = string;

export type RelayTextStyle = "bold" | "italic" | "underline" | "strikethrough";

/** Formatting run over a text part, in the same UTF-16 offsets mentions use. */
export type RelayStyleRange = {
  start: number;
  length: number;
  styles: RelayTextStyle[];
};

export type RelayMediaKind = "image" | "video" | "audio" | "file";

export type RelayPollSelection = "single" | "multiple";
export type RelayPollState = "open" | "closed";

export type RelayPollOption = {
  option_id: RelayId;
  position: number;
  text: string;
  vote_count: number;
  voters: RelayId[];
  [key: string]: unknown;
};

/**
 * A poll as this reader sees it. The answers are normalized state, never
 * message content: a second voter is an insert, not an edit of the sender's
 * message.
 */
export type RelayPoll = {
  poll_id: RelayId;
  part_id: RelayId;
  message_id: RelayId;
  question: string;
  selection: RelayPollSelection;
  state: RelayPollState;
  /** Open AND not past `closes_at`. */
  accepting_votes: boolean;
  closes_at: string | null;
  closed_at: string | null;
  options: RelayPollOption[];
  total_votes: number;
  viewer_votes: RelayId[];
  [key: string]: unknown;
};

/** The part kinds this version of the SDK knows how to render. */
export const KNOWN_PART_KINDS = [
  "text",
  "media",
  "voice_memo",
  "link_preview",
  "data",
  "poll",
] as const;

export type RelayKnownPartKind = (typeof KNOWN_PART_KINDS)[number];

/**
 * One part of a message.
 *
 * `type` is `string` rather than a union on purpose: Relay ships new part
 * kinds without a version bump, and a client that rejected one would break on
 * a message it could have rendered. Narrow with `isKnownPartKind` and fall
 * back to the message's `fallback_text` for anything else.
 */
export type RelayPart = {
  /** Permanent part identity, assigned at commit. */
  part_id: RelayId;
  /** Position of this part in the message, from 0. */
  part_index: number;
  type: string;
  text?: string;
  mentions?: RelayMention[];
  styles?: RelayStyleRange[];
  url?: string;
  /**
   * `link_preview` parts: the metadata the sender resolved. Stored with the
   * part and echoed on history reads; absent from send responses and event
   * payloads, so a client that needs it reads the message back.
   */
  title?: string;
  description?: string;
  attachment_id?: RelayId;
  content_type?: string;
  media_kind?: RelayMediaKind;
  filename?: string;
  size_bytes?: number;
  duration_ms?: number;
  width?: number;
  height?: number;
  blur_hash?: string;
  data?: unknown;
  poll?: RelayPoll;
  [key: string]: unknown;
};

/** Narrows a part to a kind this SDK version publishes a shape for. */
export function isKnownPartKind(
  part: RelayPart,
): part is RelayPart & { type: RelayKnownPartKind } {
  return (KNOWN_PART_KINDS as readonly string[]).includes(part.type);
}

/** A part as a client submits it. The server mints the identity. */
export type RelayOutgoingPart =
  | { type: "text"; text: string; mentions?: RelayMention[]; styles?: RelayStyleRange[] }
  | {
    type: "media";
    attachment_id?: RelayId;
    url?: string;
    content_type?: string;
    media_kind?: RelayMediaKind;
    filename?: string;
    size_bytes?: number;
    width?: number;
    height?: number;
    blur_hash?: string;
  }
  | { type: "voice_memo"; attachment_id?: RelayId; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string; title?: string; description?: string }
  | { type: "data"; data: Record<string, unknown> }
  | {
    type: "poll";
    question: string;
    options: Array<{ text: string }>;
    selection?: RelayPollSelection;
    closes_at?: string;
  };

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/**
 * The reply edge: a pointer, never a copy.
 *
 * Relay stores no quote snapshot, so there is nothing to go stale and no
 * quote state to interpret. Draw the quote from the target message you
 * already hold; a target this reader cannot see resolves to nothing, and the
 * reply renders without a quote.
 */
export type RelayReplyRef = {
  message_id: RelayId;
  /** Present when the reply targeted one specific part. */
  part_id?: RelayId;
  [key: string]: unknown;
};

/** A reply target on a send. */
export type RelayReplyTarget = {
  message_id: RelayId;
  part_id?: RelayId;
};

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * A reaction as projected onto a message. One per (message, target slot,
 * actor): adding a second emoji to the same slot replaces the first.
 */
export type RelayReaction = {
  /** The part this reaction targets; null for a whole-message reaction. */
  target_part_id: RelayId | null;
  emoji: string;
  actor_kind: "user" | "agent";
  actor_id: RelayId;
  created_at: string;
  [key: string]: unknown;
};

/** The reaction endpoint's result, and the `reaction.*` event payload. */
export type RelayReactionResult = {
  message_id: RelayId;
  target_part_id: RelayId | null;
  type: "emoji";
  emoji: string;
  actor: RelayActor;
  operation: "add" | "remove";
  /** False on a no-op. Relay emits no event when this is false. */
  changed: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Direct conversations carry one stamp per message; a group message is always
 * `sent`, the way iMessage behaves in groups.
 */
export type RelayMessageStatus = "sent" | "delivered" | "read";

/** `notice` is a group notice ("Alice added Bob"), sent by the person who did it. */
export type RelayMessageKind = "message" | "notice";

/**
 * One stored message as one viewer sees it.
 *
 * Content is immutable: there is no edit, no unsend, no version and no
 * tombstone. A message that exists has parts.
 */
export type RelayMessage = {
  id: RelayId;
  conversation_id: RelayId;
  sequence: number;
  kind: RelayMessageKind;
  sender: RelaySender;
  is_from_me: boolean;
  parts: RelayPart[];
  reply_to: RelayReplyRef | null;
  /** Resolved on reads. Send responses and event payloads omit it. */
  reactions?: RelayReaction[];
  fallback_text: string;
  status: RelayMessageStatus;
  delivered_at?: string;
  read_at?: string;
  created_at: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RelayEventType =
  | "message.received"
  | "message.delivered"
  | "message.read"
  | "conversation.added"
  | "conversation.updated"
  | "conversation.removed"
  | "conversation.left"
  | "reaction.added"
  | "reaction.removed"
  | "poll.updated";

/**
 * One envelope from `GET /v1/events`, identical to what a webhook delivers.
 *
 * `event_type` is `string` rather than the union above for the same reason
 * part types are: Relay adds event types without a version bump.
 */
export type RelayEventEnvelope<TData = Record<string, unknown>> = {
  event_id: string;
  /** This agent's position in its own log; the value to send back as `after`. */
  sequence: number;
  event_type: string;
  agent_id: RelayId;
  conversation_id: RelayId | null;
  created_at: string;
  /** The envelope shape this delivery was rendered as, as a date. */
  schema_version?: string;
  data: TData;
  [key: string]: unknown;
};

export type MessageReceivedData = {
  message: RelayMessage;
};

export type MessageReceivedEvent = RelayEventEnvelope<MessageReceivedData>;

/**
 * One page of `GET /v1/events?after=N`.
 *
 * A plain pull, not a consumer session: there is no exclusive consumer, no
 * acknowledgement handshake and no reconcile step. Delivery is at least once,
 * so ignore an event you have already seen.
 */
export type RelayEventsPage = {
  events: RelayEventEnvelope[];
  /** Pass as `after` on the next poll. */
  nextCursor: number;
  /** The highest sequence Relay has issued to this agent. */
  latest: number;
  /** True when `nextCursor` is behind `latest` — poll again immediately. */
  hasMore: boolean;
};

export type RelayAgentProfile = {
  id: RelayId;
  owner_user_id?: RelayId;
  handle: string;
  display_name: string;
  tagline?: string;
  avatar_url?: string | null;
  visibility?: "private" | "unlisted" | "public";
  created_at?: string;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The result of a send. One send is one message: the `msg_` id you minted is
 * the message's identity and the send's only retry key.
 */
export type RelaySendResult = {
  messageId: RelayId;
  message: RelayMessage;
};

export type RelayAttachment = {
  id: RelayId;
  url: string;
  content_type: string;
  size_bytes: number;
  [key: string]: unknown;
};

export type RelayHistoryPage = {
  messages: RelayMessage[];
};

/** The watermark a read/delivered receipt advanced to. */
export type RelayReceipt = {
  message_id: RelayId;
  conversation_id: RelayId;
  through_sequence: number;
  recipient: RelayActor;
  status: "delivered" | "read";
  at: string;
  [key: string]: unknown;
};
