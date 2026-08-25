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

export type RelaySender = {
  kind: "user" | "agent" | "system";
  id: RelayId;
  display_name?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** Inline mention over a text part. Offsets are UTF-16 code units over `text`. */
export type RelayMentionRange = {
  start: number;
  length: number;
  participant_id: RelayId;
};

export type RelayTextStyle =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "monospace"
  | "spoiler";

/** Formatting run over a text part, in the same UTF-16 offsets mentions use. */
export type RelayStyleRange = {
  start: number;
  length: number;
  styles: RelayTextStyle[];
};

export type RelayMediaKind = "image" | "video" | "audio" | "file";

/** The part kinds this version of the SDK knows how to render. */
export const KNOWN_PART_KINDS = [
  "text",
  "media",
  "voice_memo",
  "link_preview",
  "data",
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
  /** Permanent part identity. Survives edits, moves and removal. */
  part_id: RelayId;
  /** Retained for clients that predate part ids. Always equal to `position`. */
  part_index: number;
  /** Dense presentation position in the current version, from 0. */
  position: number;
  type: string;
  text?: string;
  mentions?: RelayMentionRange[];
  styles?: RelayStyleRange[];
  url?: string;
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
  | { type: "text"; text: string; mentions?: RelayMentionRange[]; styles?: RelayStyleRange[] }
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
  | { type: "data"; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export type RelayQuoteState =
  | "active"
  | "unsent"
  | "part_removed"
  | "moderated"
  | "redacted"
  | "unavailable";

/** A snapshot of a reply's target, frozen when the reply committed. */
export type RelayReplyQuote = {
  sender: RelaySender;
  target_kind: string;
  text_preview?: string;
  media?: {
    attachment_id?: RelayId;
    content_type?: string;
    width?: number;
    height?: number;
    blur_hash?: string;
  };
  target_part_id?: RelayId;
  target_version_id: RelayId;
  [key: string]: unknown;
};

/**
 * The reply edge as this reader sees it.
 *
 * `message_id` and `part_id` are permanent and never repoint. `quote_state`
 * and `quote` are what changed since: losing the target redacts the quote
 * rather than moving the edge to whatever now sits in that slot.
 */
export type RelayReplyRef = {
  message_id: RelayId;
  part_id?: RelayId;
  quote_state: RelayQuoteState;
  quote?: RelayReplyQuote;
  [key: string]: unknown;
};

/** A reply target on a send. `/v2` accepts `part_id` only. */
export type RelayReplyTarget = {
  message_id: RelayId;
  part_id?: RelayId;
  /** @deprecated Legacy index form, accepted on `/v1` only. Use `part_id`. */
  part_index?: number;
};

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/** A reaction as projected onto a message. */
export type RelayReaction = {
  /** The target part's current position, or null on a whole-message reaction. */
  part_index: number | null;
  target_scope: "message" | "part";
  /** Null exactly when `target_scope` is `message`. This is the identity. */
  target_part_id: RelayId | null;
  emoji: string;
  actor_kind: "user" | "agent";
  actor_id: RelayId;
  created_at?: string;
  [key: string]: unknown;
};

/** The reaction endpoint's result, and the `reaction.*` event payload. */
export type RelayReactionResult = {
  message_id: RelayId;
  part_index: number | null;
  target_scope: "message" | "part";
  target_part_id: RelayId | null;
  type: "emoji";
  emoji: string;
  actor: RelaySender;
  operation: "add" | "remove";
  /** False on a no-op. Relay emits no event when this is false. */
  changed: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type RelayReceiptSummary = {
  eligible: number;
  delivered: number;
  read: number;
  delivered_state: "none" | "partial" | "complete";
  read_state: "none" | "partial" | "complete";
  first_delivered_at?: string;
  first_read_at?: string;
  complete_delivered_at?: string;
  complete_read_at?: string;
  [key: string]: unknown;
};

/** A prior version of a message. The current version is never in this list. */
export type RelayRevision = {
  version?: number;
  parts: RelayPart[];
  fallback_text: string;
  created_at?: string;
  replaced_at: string;
  [key: string]: unknown;
};

export type RelayPartEditAction = "update" | "remove" | "move" | "replace";

/** What the server says this reader may do to this message right now. */
export type RelayEditCapabilities = {
  can_edit: boolean;
  version: number;
  /** Keyed by `part_id`. Empty when `can_edit` is false. */
  editable_parts: Record<string, RelayPartEditAction[]>;
  [key: string]: unknown;
};

export type RelayMessageStatus =
  | "sent"
  | "delivered"
  | "read"
  | "completed"
  | "failed";

/** A message that still has content. */
export type RelayVisibleMessage = {
  id: RelayId;
  conversation_id: RelayId;
  sequence: number;
  sender: RelaySender;
  is_from_me: boolean;
  invoked_agents?: RelayId[];
  parts: RelayPart[];
  reply_to: RelayReplyRef | null;
  reactions?: RelayReaction[];
  fallback_text: string;
  status: RelayMessageStatus;
  delivered_at?: string;
  read_at?: string;
  receipt_summary?: RelayReceiptSummary;
  edited_at?: string;
  revisions?: RelayRevision[];
  /** 1 for a never-edited message; 6 is the ceiling. */
  version: number;
  edit_capabilities?: RelayEditCapabilities;
  created_at: string;
  status_deleted?: never;
  [key: string]: unknown;
};

/** What is left after an unsend: the identity, and nothing else. */
export type RelayTombstone = {
  id: RelayId;
  conversation_id: RelayId;
  sequence: number;
  sender: RelaySender;
  is_from_me?: boolean;
  status: "deleted";
  /** Present iff the sender unsent it; absent for moderation. */
  unsent_at?: string;
  created_at: string;
  [key: string]: unknown;
};

export type RelayMessage = RelayVisibleMessage | RelayTombstone;

/** True when the message still has content. Narrow before reading `parts`. */
export function isVisibleMessage(
  message: RelayMessage,
): message is RelayVisibleMessage {
  return message.status !== "deleted";
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export type RelayPartOperation =
  | {
    action: "update";
    part_id: RelayId;
    text?: string;
    mentions?: RelayMentionRange[];
    styles?: RelayStyleRange[];
  }
  | { action: "add"; position?: number; part: RelayOutgoingPart }
  | { action: "remove"; part_id: RelayId }
  | { action: "move"; part_id: RelayId; position: number }
  | { action: "replace"; part_id: RelayId; part: RelayOutgoingPart };

export type RelayEditRequest = {
  operation_id: RelayId;
  expected_version: number;
  operations: RelayPartOperation[];
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RelayEventEnvelope<TData = Record<string, unknown>> = {
  event_id: string;
  event_type: string;
  agent_id: RelayId;
  created_at: string;
  /** The envelope shape this delivery was rendered as, as a date. */
  schema_version?: string;
  data: TData;
  [key: string]: unknown;
};

export type MessageReceivedData = {
  message: RelayMessage;
  invocation_id?: string;
};

export type MessageReceivedEvent = RelayEventEnvelope<MessageReceivedData>;

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

export type RelayEventsPage = {
  events: RelayEventEnvelope[];
  nextCursor: number;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The 202 from `POST /v1/messages`. The server splits the accepted parts at
 * ingest: each visible non-media part becomes its own message, contiguous
 * media parts stay one media message, and a voice memo always commits alone,
 * so one send commits one or more messages, in display order.
 */
export type RelaySendResult = {
  /**
   * @deprecated The first committed message's id. A `/v1` send can commit
   * several messages; read `messages`. On `/v2` it is the id you minted.
   */
  messageId: RelayId;
  /** The first committed message, for callers written before the split. */
  message: RelayMessage;
  /** Every message this send committed, in display order. */
  messages: RelayMessage[];
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

export type RelayReconcileResult = {
  reconciled: true;
  resumeCursor: number;
};
