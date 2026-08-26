/**
 * Wire types for the Relay v1 developer API, scoped to what this plugin
 * consumes and produces. Contract: https://docs.relayapp.im/reference/events
 * and the live OpenAPI document. The part discriminator is `type`.
 *
 * Message content is immutable: there is no edit, no unsend, no version and no
 * tombstone. A message that exists has parts.
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
 * Anyone who can act in a conversation. There is no `system` sender: a group
 * notice is a real message sent by the person who caused it.
 */
export interface RelayMessageSender {
  kind: "user" | "agent";
  id: string;
  display_name?: string;
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
  | { type: "text"; text: string; mentions?: RelayMention[]; styles?: RelayStyleRange[] }
  | {
      type: "media";
      attachment_id?: string;
      url?: string;
      /** Optional pixel dimensions, always provided together. */
      width?: number;
      height?: number;
      /** Optional blurhash placeholder (base83). Derived by the server for
       * image attachments when omitted. */
      blur_hash?: string;
    }
  | { type: "voice_memo"; attachment_id?: string; url?: string; duration_ms?: number }
  | { type: "link_preview"; url: string }
  | { type: "data"; data: Record<string, unknown> };

/** Stored canonical part as delivered in events and history. */
export type RelayPart = {
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
  duration_ms?: number;
  width?: number;
  height?: number;
  blur_hash?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * The reply edge: a pointer, never a copy. Relay stores no quote snapshot, so
 * draw the quote from the target message you already hold.
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

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  kind?: RelayMessageKind;
  sender: RelayMessageSender;
  parts: RelayPart[];
  reply_to?: RelayReplyRef | null;
  /** Resolved on reads. Send responses and event payloads omit it. */
  reactions?: RelayReaction[];
  fallback_text?: string;
  status?: string;
  created_at: string;
}

export interface MessageReceivedData {
  message: RelayMessage;
}

export type MessageReceivedEvent = RelayEventEnvelope<MessageReceivedData>;

/**
 * The 202 from `POST /v1/messages`. One send is one message: the `msg_` id the
 * client minted is the message's identity and the send's only retry key.
 */
export interface SendResult {
  message_id: string;
  message: RelayMessage;
}
