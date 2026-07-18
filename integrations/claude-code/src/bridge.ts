/**
 * Pure mapping logic between Relay wire shapes and the Claude Code channel
 * contract (code.claude.com/docs/en/channels-reference). No I/O here so every
 * branch is unit-testable.
 */

import type {
  PermissionBehavior,
  PermissionRequest,
  PermissionVerdict,
  RelayEvent,
  RelayMessage,
  RelayPart,
  SendMessageBody,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Inbound event classification
// ---------------------------------------------------------------------------

export type InboundAction =
  | { kind: "ignore"; reason: string }
  | { kind: "blocked_sender"; sender: string }
  | { kind: "verdict"; verdict: PermissionVerdict }
  | {
      kind: "message";
      content: string;
      meta: Record<string, string>;
      conversationId: string;
      sender: string;
    };

/**
 * Verdict text fallback, per the channels reference: matches "y abcde",
 * "yes abcde", "n abcde", "no abcde". [a-km-z] is the request-id alphabet
 * Claude Code uses (five lowercase letters, never "l"); /i tolerates phone
 * autocorrect capitalization — the capture is lowercased before emitting.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

const REQUEST_ID_RE = /^[a-km-z]{5}$/;

export function parseVerdictText(text: string): PermissionVerdict | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    request_id: m[2].toLowerCase(),
    behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny",
  };
}

function normalizeBehavior(value: unknown): PermissionBehavior | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "allow" || v === "yes" || v === "y" || v === "approve") return "allow";
  if (v === "deny" || v === "no" || v === "n" || v === "reject") return "deny";
  return null;
}

/**
 * Parses an origin-tagged option tap carried in a `data` part. The permission
 * card we send tags each option with the request id (see buildPermissionCard);
 * the app's tap reply echoes the origin. Accepted shapes, checked in order:
 *
 *   { origin: { kind: "claude_permission_request", request_id }, option_id }
 *   { origin: { request_id }, option: "allow" | "deny" }
 *   { kind: "claude_permission_request", request_id, behavior | option_id }
 *
 * The request id must match the Claude Code alphabet; the option value must
 * normalize to allow/deny. Anything else is not a verdict.
 */
export function parseVerdictDataPart(data: unknown): PermissionVerdict | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;

  let requestId: unknown;
  const origin = record.origin;
  if (typeof origin === "object" && origin !== null) {
    requestId = (origin as Record<string, unknown>).request_id;
  }
  if (typeof requestId !== "string") requestId = record.request_id;
  if (typeof requestId !== "string") return null;
  const id = requestId.toLowerCase();
  if (!REQUEST_ID_RE.test(id)) return null;

  const behavior =
    normalizeBehavior(record.option_id) ??
    normalizeBehavior(record.option) ??
    normalizeBehavior(record.choice) ??
    normalizeBehavior(record.behavior);
  if (!behavior) return null;

  return { request_id: id, behavior };
}

/**
 * Outstanding permission requests. Ids are added when Claude Code sends a
 * permission_request, removed on the first verdict, and expire after a TTL so
 * a stale id can never be answered later. Everything verdict-shaped that does
 * not hit a live id falls through to normal chat.
 */
export class PendingRequests {
  private readonly expiries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = options?.ttlMs ?? 10 * 60 * 1000;
    this.now = options?.now ?? Date.now;
  }

  add(requestId: string): void {
    this.prune();
    this.expiries.set(requestId, this.now() + this.ttlMs);
  }

  /** True while the id is open and unexpired. */
  has(requestId: string): boolean {
    this.prune();
    return this.expiries.has(requestId);
  }

  /** Removes the id; a second verdict for it will no longer match. */
  resolve(requestId: string): void {
    this.expiries.delete(requestId);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expiry] of this.expiries) {
      if (expiry <= now) this.expiries.delete(id);
    }
  }
}

function extractMessage(event: RelayEvent): RelayMessage | null {
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const message = (data as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const m = message as RelayMessage;
  if (typeof m.conversation_id !== "string" || !Array.isArray(m.parts)) return null;
  if (typeof m.sender !== "object" || m.sender === null) return null;
  return m;
}

function textOfMessage(message: RelayMessage): string {
  const texts = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text as string);
  if (texts.length > 0) return texts.join("\n");
  return message.fallback_text ?? "";
}

/**
 * Maps one Relay event to a channel action. Gate order matters: sender checks
 * run before any content is interpreted, so an unauthorized sender can neither
 * reach Claude's context nor answer a permission prompt.
 *
 * Verdict parsing (both the data-part tap and the text fallback) is gated on
 * `isPendingRequest`: only ids from a currently-open permission_request are
 * treated as verdicts. Without this gate, natural messages like "no worry" or
 * "yes right" (five id-alphabet letters after y/n) would be swallowed as
 * verdicts and never reach Claude. Non-pending matches fall through to chat.
 */
export function classifyEvent(
  event: RelayEvent,
  ownerUserId: string | null,
  isPendingRequest: (requestId: string) => boolean = () => false,
): InboundAction {
  if (event.event_type !== "message.received") {
    return { kind: "ignore", reason: `unhandled event_type ${event.event_type}` };
  }
  const message = extractMessage(event);
  if (!message) return { kind: "ignore", reason: "malformed message.received payload" };

  // Gate on the sender's identity (user id), never the conversation.
  if (message.sender.kind !== "user") {
    return { kind: "ignore", reason: `non-user sender kind ${message.sender.kind}` };
  }
  if (ownerUserId !== null && message.sender.id !== ownerUserId) {
    return { kind: "blocked_sender", sender: message.sender.id };
  }

  // Verdict paths never fall through to chat: a tap or a "yes <id>" reply for
  // an OPEN request is consumed here and must not be injected into Claude's
  // context. Matches without an open request are ordinary chat.
  for (const part of message.parts) {
    if (part.type !== "data") continue;
    const verdict = parseVerdictDataPart(part.data);
    if (verdict && isPendingRequest(verdict.request_id)) return { kind: "verdict", verdict };
  }
  const text = textOfMessage(message);
  const textVerdict = parseVerdictText(text);
  if (textVerdict && isPendingRequest(textVerdict.request_id)) {
    return { kind: "verdict", verdict: textVerdict };
  }

  if (text.length === 0) return { kind: "ignore", reason: "empty message body" };
  return {
    kind: "message",
    content: text,
    meta: { chat_id: message.conversation_id, sender: message.sender.id },
    conversationId: message.conversation_id,
    sender: message.sender.id,
  };
}

// ---------------------------------------------------------------------------
// Outbound permission card
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION_CHARS = 500;
const MAX_PREVIEW_CHARS = 1500;

/**
 * Defense-in-depth over the client-side sanitization Claude Code >=2.1.211
 * already applies: neutralize direction-override/invisible characters, fold
 * whitespace runs, clamp length. Treat both fields as untrusted.
 */
export function sanitizeRelayedText(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

export interface PermissionCard {
  body: SendMessageBody;
  idempotencyKey: string;
}

/**
 * Builds the Relay message that relays a permission prompt to the owner's
 * phone. The data part is the machine-readable card (Allow/Deny options
 * origin-tagged with the request id for tap replies); the text part is the
 * human-readable rendering plus the "yes <id>" / "no <id>" text fallback, so
 * clients without data-part rendering still work.
 */
export function buildPermissionCard(
  request: PermissionRequest,
  conversationId: string,
): PermissionCard {
  const toolName = sanitizeRelayedText(request.tool_name, 100) || "a tool";
  const description = sanitizeRelayedText(request.description, MAX_DESCRIPTION_CHARS);
  const inputPreview = sanitizeRelayedText(request.input_preview, MAX_PREVIEW_CHARS);
  const id = request.request_id;

  const lines = [`Claude wants to run ${toolName}: ${description}`];
  if (inputPreview.length > 0) lines.push("", inputPreview);
  lines.push("", `Reply "yes ${id}" to allow or "no ${id}" to deny.`);

  return {
    body: {
      conversation_id: conversationId,
      parts: [
        { type: "text", text: lines.join("\n") },
        {
          type: "data",
          data: {
            kind: "claude_permission_request",
            request_id: id,
            tool_name: toolName,
            description,
            input_preview: inputPreview,
            options: [
              {
                id: "allow",
                label: "Allow",
                origin: { kind: "claude_permission_request", request_id: id },
              },
              {
                id: "deny",
                label: "Deny",
                origin: { kind: "claude_permission_request", request_id: id },
              },
            ],
          },
        },
      ],
    },
    // Deterministic per request id: a retried relay of the same prompt can
    // never post the card twice. (Server requires 8..255 chars.)
    idempotencyKey: `claude-perm-${id}`,
  };
}

/** Builds the reply-tool send body. */
export function buildReply(chatId: string, text: string): SendMessageBody {
  return { conversation_id: chatId, parts: [{ type: "text", text }] };
}

export function firstTextPart(parts: RelayPart[]): string | undefined {
  return parts.find((p) => p.type === "text" && p.text)?.text;
}
