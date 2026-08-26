/**
 * Wire types for the Relay developer API, scoped to what this adapter consumes
 * and produces. The authoritative contract is the published OpenAPI document at
 * https://docs.relayapp.im/api-reference. The part discriminator is `type`.
 *
 * Message content is immutable: there is no edit, no unsend, no version and no
 * tombstone. A message that exists has parts, so nothing here is optional
 * because a tombstone might have dropped it.
 */

export interface RelayEventEnvelope<TData = unknown> {
  event_id: string;
  /** This agent's position in its own log; the poll cursor. */
  sequence?: number;
  event_type: string;
  agent_id: string;
  conversation_id?: string | null;
  created_at: string;
  data: TData;
}

/**
 * Anyone who can act in a conversation. There is no `system` actor: a group
 * notice is a real message sent by the person who caused it.
 */
export interface RelaySender {
  kind: "user" | "agent";
  id: string;
}

/**
 * A mention is the handle it names. A sender confirms handles from the
 * client's suggestion list, and the server checks each one is really written
 * as `@handle` in the part's `text`. There are no offsets: a range could mark
 * any word as a mention of anyone, a handle can only ever mark itself.
 */
export type RelayMention = string;

export type RelayTextStyle = "bold" | "italic" | "underline" | "strikethrough";

/**
 * One formatting run over a text part, offsets in UTF-16 code units like
 * mentions. An EMPTY `styles` array on the part is meaningful: it marks
 * structured plain text as opposed to a legacy Markdown body.
 */
export interface RelayStyleRange {
  start: number;
  length: number;
  styles: RelayTextStyle[];
}

/** Outgoing part shapes accepted by `POST /v1/messages`. */
export type RelayOutgoingPart =
  | {
      type: "text";
      text: string;
      mentions?: RelayMention[];
      styles?: RelayStyleRange[];
    }
  | {
      type: "media";
      attachment_id?: string;
      url?: string;
      content_type?: string;
    }
  | { type: "voice_memo"; attachment_id?: string; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string; title?: string; description?: string }
  | { type: "data"; data: Record<string, unknown> };

/** Stored canonical part as delivered in events and history. */
export interface RelayPart {
  /** Permanent part identity, assigned at commit. */
  part_id: string;
  /** Position of this part in the message, from 0. */
  part_index: number;
  type: string;
  text?: string;
  mentions?: RelayMention[];
  styles?: RelayStyleRange[];
  url?: string;
  attachment_id?: string;
  content_type?: string;
  media_kind?: "image" | "video" | "audio" | "file";
  filename?: string;
  size_bytes?: number;
  duration_ms?: number;
  width?: number;
  height?: number;
  blur_hash?: string;
  title?: string;
  description?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The reply edge: a pointer, never a copy.
 *
 * Relay stores no quote snapshot, so there is nothing to go stale. Draw the
 * quote from the target message you already hold; a target this reader cannot
 * see resolves to nothing and the reply renders without one.
 */
export interface RelayReplyRef {
  message_id: string;
  /** Present when the reply targeted one specific part. */
  part_id?: string;
}

/**
 * A reaction as projected onto a message. One per (message, target slot,
 * actor): adding a second emoji to the same slot replaces the first.
 */
export interface RelayReaction {
  /** The part this reaction targets; null for a whole-message reaction. */
  target_part_id: string | null;
  emoji: string;
  actor_kind: "user" | "agent";
  actor_id: string;
  created_at: string;
}

/** `notice` is a group notice ("Alice added Bob"), sent by the person who did it. */
export type RelayMessageKind = "message" | "notice";

/** A message as Relay projects it for this agent. */
export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  kind: RelayMessageKind;
  sender: RelaySender;
  is_from_me?: boolean;
  parts: RelayPart[];
  reply_to?: RelayReplyRef | null;
  /** Resolved on reads. Send responses and event payloads omit it. */
  reactions?: RelayReaction[];
  fallback_text?: string;
  status: string;
  delivered_at?: string;
  read_at?: string;
  created_at: string;
}

export interface RelayMessageEventData {
  message: RelayMessage;
}

/**
 * The 202 from `POST /v1/messages`. One send is one message: the `msg_` id the
 * client minted is the message's identity and the send's only retry key.
 */
export interface RelaySendResult {
  message_id: string;
  message: RelayMessage;
}

export interface RelayConversation {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  counterpart_user: {
    id: string;
    display_name: string;
    avatar_url: string | null;
  } | null;
  participant_count: number;
  last_sequence: number;
  last_message_at: string | null;
  created_at: string;
}

export interface RelayUserProfile {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone_number: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface RelayAttachment {
  id: string;
  url: string;
  content_type: string;
  size_bytes: number;
}

/**
 * Relay carries one reaction kind. The field survives because the wire still
 * names it, not because there is a choice to make.
 */
export type RelayReactionType = "emoji";

/** The raw payload this adapter hands to the Chat SDK. */
export interface RelayRawMessage {
  message: RelayMessage;
  event_id?: string;
  event_type?: string;
}

/** Platform-specific data behind a Relay thread id. */
export interface RelayThreadId {
  conversationId: string;
}
