// Pure inbound mapping: Relay events -> normalized fact bundles.
// No SDK imports so the mapping is unit-testable without an OpenClaw runtime;
// the runtime dispatch wiring lives in channel.ts.
import type { RelayEvent, RelayMessage, RelayPart } from "./types.js";

/** Coarse classification deciding whether an event can start an agent turn. */
export type RelayEventClass =
  | "message" // message.received -> can start an agent turn
  | "reaction" // reaction.added/removed -> observe-only at v1
  | "lifecycle" // message.delivered/read -> bookkeeping, never dispatch
  | "unknown"; // forward-compatible: ignore quietly

export function classifyRelayEvent(event: Pick<RelayEvent, "event_type">): RelayEventClass {
  switch (event.event_type) {
    case "message.received":
      return "message";
    case "reaction.added":
    case "reaction.removed":
      return "reaction";
    case "message.delivered":
    case "message.read":
      return "lifecycle";
    default:
      return "unknown";
  }
}

/**
 * Render typed parts into agent-facing text: text parts joined, link URLs
 * inlined, `data` parts as a compact JSON fence, media/voice as a labeled
 * fetchable URL. The URL is a capability link: it is the authorization, so
 * any HTTP client can fetch the bytes without an Agent Token.
 */
export function renderRelayPartsText(parts: readonly RelayPart[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          lines.push(part.text);
        }
        break;
      case "link_preview":
        lines.push(part.url);
        break;
      case "data": {
        let rendered: string;
        try {
          rendered = JSON.stringify(part.data);
        } catch {
          rendered = String(part.data);
        }
        lines.push("```json\n" + rendered + "\n```");
        break;
      }
      case "media":
        lines.push(`[attachment] ${part.url}`);
        break;
      case "voice_memo":
        lines.push(
          part.duration_ms
            ? `[voice memo, ${Math.round(part.duration_ms / 1000)}s] ${part.url}`
            : `[voice memo] ${part.url}`,
        );
        break;
    }
  }
  return lines.join("\n");
}

/** Drop the agent's own sends echoed back on the event stream. */
export function isRelayEchoMessage(
  message: Pick<RelayMessage, "sender">,
  agentId: string,
): boolean {
  return message.sender.kind === "agent" && message.sender.id === agentId;
}

/** Normalized facts for one dispatchable inbound message. */
export type RelayInboundFacts = {
  eventId: string;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderKind: "user" | "agent";
  replyToId?: string;
  text: string;
  timestamp?: number;
  /**
   * The group invocation this message belongs to, when it is group work.
   * Every subsequent server call about this message must carry it back, and
   * because only a group mints one, its presence is also the group signal.
   */
  invocationId?: string;
};

/**
 * Build the dispatchable fact bundle for a message.received event. Returns
 * null when the event should not start a turn: echoes of our own agent,
 * non-message events, or messages with no renderable content.
 */
export function buildRelayInboundFacts(
  event: RelayEvent,
  params: { agentId: string },
): RelayInboundFacts | null {
  if (classifyRelayEvent(event) !== "message") {
    return null;
  }
  const message = event.data.message;
  if (!message || !message.id || !message.conversation_id) {
    return null;
  }
  // Agent-authored messages never start a local agent turn. This drops our
  // own event echo and prevents agent-to-agent loops even if an id is
  // mistakenly added to the user allowlist.
  if (message.sender.kind !== "user" || isRelayEchoMessage(message, params.agentId)) {
    return null;
  }
  const text = renderRelayPartsText(message.parts) || message.fallback_text || "";
  if (!text.trim()) {
    return null;
  }
  const createdAtMs = Date.parse(message.created_at);
  const invocationId = typeof event.data.invocation_id === "string"
    && event.data.invocation_id.trim()
    ? event.data.invocation_id
    : undefined;
  return {
    eventId: event.event_id,
    messageId: message.id,
    conversationId: message.conversation_id,
    senderId: message.sender.id,
    senderKind: message.sender.kind,
    ...(message.reply_to?.message_id ? { replyToId: message.reply_to.message_id } : {}),
    text,
    ...(Number.isFinite(createdAtMs) ? { timestamp: createdAtMs } : {}),
    ...(invocationId ? { invocationId } : {}),
  };
}
