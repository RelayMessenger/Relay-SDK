/**
 * Relay wire shapes used by the channel server. These mirror the /v1 contract
 * from Relay's public agent API. The plugin keeps its own copies because the
 * installed runtime is standalone under ${CLAUDE_PLUGIN_ROOT}.
 */

export type RelayPartType =
  | "text"
  | "media"
  | "voice_memo"
  | "link_preview"
  | "data"
  | "poll";

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

export interface RelayPart {
  /** Permanent part identity, assigned at commit. Absent on a send. */
  part_id?: string;
  part_index?: number;
  type: RelayPartType;
  text?: string;
  /** Text parts only. */
  mentions?: RelayMention[];
  styles?: RelayStyleRange[];
  url?: string;
  attachment_id?: string;
  duration_ms?: number;
  /** Media parts only: pixel dimensions (always paired) and a blurhash
   * placeholder (base83) to draw before the bytes download. */
  width?: number;
  height?: number;
  blur_hash?: string;
  data?: unknown;
}

/**
 * An actor is a person or an agent. A group notice ("Alice added Bob") is a
 * real message from the person who did it, not a message from the system.
 */
export interface RelaySender {
  kind: "user" | "agent";
  id: string;
}

/** `notice` is a group notice; only `message` is addressed to anybody. */
export type RelayMessageKind = "message" | "notice";

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  kind?: RelayMessageKind;
  sender: RelaySender;
  is_from_me?: boolean;
  parts: RelayPart[];
  /** A pointer to the target, never a stored quote. */
  reply_to?: { message_id: string; part_id?: string } | null;
  fallback_text?: string;
  status?: string;
  created_at: string;
}

/** Developer-facing event envelope from GET /v1/events (AgentEventEnvelope). */
export interface RelayEvent {
  event_id: string;
  /** This agent's position in its own log; the value to send back as `after`. */
  sequence?: number;
  event_type: string;
  agent_id: string;
  created_at: string;
  data: unknown;
}

export interface PollEventsResponse {
  events: RelayEvent[];
  next_cursor: number;
  /** Highest sequence Relay has issued this agent, and whether the page
   * stopped short of it. `has_more` means poll again without waiting. */
  latest: number;
  has_more: boolean;
}

/** Body for POST /v1/messages (agent bearer auth). */
export interface SendMessageBody {
  conversation_id: string;
  /**
   * The `msg_` id this client minted. It is the message's identity AND the
   * send's only retry key: same id replays, a new id is a new message.
   */
  message_id: string;
  parts: RelayPart[];
}

/** Fields of notifications/claude/channel/permission_request params. */
export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export type PermissionBehavior = "allow" | "deny";

export interface PermissionVerdict {
  request_id: string;
  behavior: PermissionBehavior;
}
