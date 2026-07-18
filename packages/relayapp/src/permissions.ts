/**
 * Permission broker: turns an engine permission ask into a Relay card and
 * blocks until the phone answers (or the window expires → deny).
 *
 * Wire shape is shared with the Claude Code channel plugin
 * (integrations/claude-code/src/bridge.ts): one Relay message with a
 * human-readable text part (including the "yes <id>" / "no <id>" text
 * fallback) plus a `data` part
 *   { kind: "claude_permission_request", request_id, tool_name, description,
 *     input_preview, options: [{ id: "allow"|"deny", label,
 *     origin: { kind, request_id } }] }
 * and the same tolerant reply parser (origin-tagged data-part tap or text
 * fallback). Request ids use Claude Code's 5-char [a-km-z] alphabet.
 *
 * Pending approvals are durable resources, not in-memory callback state: each
 * ask is created (create-once) as ~/.relayapp/approvals/<request_id>.json
 * BEFORE the Relay card is posted; the loop writes the resolution when the
 * tap arrives, and the waiter (this broker's ACP path, or the codex hook in
 * another process) consumes it by unlinking the file. In-window entries stay
 * armed across restarts so a late tap is consumed instead of being forwarded
 * to the engine as a prompt; abandoned files age out after deadline + grace.
 */
import { randomInt } from "node:crypto";
import type { RelayClient } from "./api.js";
import type { ApprovalStore, PendingApproval, RelayMessage } from "./store.js";
import type { PermissionAsk, PermissionDecision } from "./engine/types.js";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export const PERMISSION_CARD_KIND = "claude_permission_request";

/** Claude Code request-id alphabet: five lowercase letters, never "l". */
const REQUEST_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz";
const REQUEST_ID_RE = /^[a-km-z]{5}$/;
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export function newRequestId(): string {
  let id = "";
  for (let i = 0; i < 5; i += 1) {
    id += REQUEST_ID_ALPHABET[randomInt(REQUEST_ID_ALPHABET.length)];
  }
  return id;
}

export interface PermissionVerdict {
  request_id: string;
  behavior: "allow" | "deny";
}

export function parseVerdictText(text: string): PermissionVerdict | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    request_id: m[2]!.toLowerCase(),
    behavior: m[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
  };
}

function normalizeBehavior(value: unknown): "allow" | "deny" | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "allow" || v === "yes" || v === "y" || v === "approve") return "allow";
  if (v === "deny" || v === "no" || v === "n" || v === "reject") return "deny";
  return null;
}

/**
 * Parses an origin-tagged option tap carried in a `data` part. Accepted
 * shapes, checked in order (identical to the channel plugin):
 *
 *   { origin: { kind: "claude_permission_request", request_id }, option_id }
 *   { origin: { request_id }, option: "allow" | "deny" }
 *   { kind: "claude_permission_request", request_id, behavior | option_id }
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

/** Extracts a verdict from a user message: data-part tap first, then text. */
export function verdictFromMessage(message: RelayMessage): PermissionVerdict | null {
  for (const part of message.parts) {
    if (part.type !== "data") continue;
    const verdict = parseVerdictDataPart((part as { data?: unknown }).data);
    if (verdict) return verdict;
  }
  const text = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text as string)
    .join("\n");
  return parseVerdictText(text.length > 0 ? text : message.fallback_text ?? "");
}

const MAX_DESCRIPTION_CHARS = 500;
const MAX_PREVIEW_CHARS = 1500;

/** Same defense-in-depth sanitization as the channel plugin. */
export function sanitizeRelayedText(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

export interface PermissionCardInput {
  requestId: string;
  conversationId: string;
  /** Human name for the asking engine: "Claude", "Codex". */
  engineLabel: string;
  toolName?: string;
  description?: string;
  inputPreview?: string;
}

export function buildPermissionCard(input: PermissionCardInput): {
  body: {
    conversation_id: string;
    parts: Array<Record<string, unknown>>;
    suggestions: Array<{ text: string }>;
  };
  idempotencyKey: string;
} {
  const toolName = sanitizeRelayedText(input.toolName ?? "", 100) || "a tool";
  const description = sanitizeRelayedText(input.description ?? "", MAX_DESCRIPTION_CHARS);
  const inputPreview = sanitizeRelayedText(input.inputPreview ?? "", MAX_PREVIEW_CHARS);
  const id = input.requestId;

  const lines = [
    `${input.engineLabel} wants to run ${toolName}${description ? `: ${description}` : ""}`,
  ];
  if (inputPreview.length > 0) lines.push("", inputPreview);
  lines.push("", `Reply "yes ${id}" to allow or "no ${id}" to deny.`);

  return {
    body: {
      conversation_id: input.conversationId,
      parts: [
        { type: "text", text: lines.join("\n") },
        {
          type: "data",
          data: {
            kind: PERMISSION_CARD_KIND,
            request_id: id,
            tool_name: toolName,
            description,
            input_preview: inputPreview,
            options: [
              { id: "allow", label: "Allow", origin: { kind: PERMISSION_CARD_KIND, request_id: id } },
              { id: "deny", label: "Deny", origin: { kind: PERMISSION_CARD_KIND, request_id: id } },
            ],
          },
        },
      ],
      // Chip text IS the sent text, so the chips carry the parseable fallback.
      suggestions: [{ text: `yes ${id}` }, { text: `no ${id}` }],
    },
    idempotencyKey: `claude-perm-${id}`,
  };
}

/** Maps a binary verdict back onto the engine's richer option set. */
export function decisionForVerdict(
  approval: PendingApproval,
  behavior: "allow" | "deny",
): PermissionDecision {
  const prefix = behavior === "allow" ? "allow" : "reject";
  const exact = approval.options.find((option) => option.kind === `${prefix}_once`);
  const fuzzy = approval.options.find((option) => option.kind?.startsWith(prefix));
  const chosen = exact ?? fuzzy;
  if (chosen) return { behavior: "selected", optionId: chosen.option_id };
  return behavior === "allow" && approval.options[0]
    ? { behavior: "selected", optionId: approval.options[0].option_id }
    : { behavior: "cancelled" };
}

export function denyDecision(approval: PendingApproval): PermissionDecision {
  return decisionForVerdict(approval, "deny");
}

interface Waiter {
  approval: PendingApproval;
  resolve(decision: PermissionDecision): void;
  timer: NodeJS.Timeout;
}

export class PermissionBroker {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly client: RelayClient,
    private readonly approvals: ApprovalStore,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /**
   * Age out abandoned approval files. Files with an unconsumed resolution are
   * owned by a waiter in another process (e.g. a codex hook) and survive
   * until their deadline + grace window; only clearly-dead entries go.
   */
  sweep(now = Date.now()): void {
    for (const requestId of this.approvals.sweep(now)) {
      this.log(`aged out abandoned approval ${requestId}`);
    }
  }

  /**
   * Called by the receive loop for every inbound owner message. Returns true
   * when the message answered a pending approval and must NOT be forwarded to
   * the engine as a prompt.
   */
  consumeReply(message: RelayMessage): boolean {
    const verdict = verdictFromMessage(message);
    if (!verdict) return false;
    const approval = this.approvals.get(verdict.request_id);
    if (!approval || approval.resolution) {
      // A verdict-shaped reply with no live ask is still consumed: it must
      // never become an engine prompt.
      return true;
    }
    // A verdict only counts from the conversation that was asked.
    if (approval.conversation_id !== message.conversation_id) {
      this.log(
        `verdict for ${verdict.request_id} from wrong conversation ` +
          `${message.conversation_id} (expected ${approval.conversation_id}) — ignored`,
      );
      return true;
    }
    const waiter = this.waiters.get(verdict.request_id);
    if (waiter) {
      // Our own ask: resolve in-process and consume the file.
      clearTimeout(waiter.timer);
      this.waiters.delete(verdict.request_id);
      this.approvals.consume(verdict.request_id);
      waiter.resolve(decisionForVerdict(approval, verdict.behavior));
    } else {
      // Armed by another process (codex hook): write the resolution for its
      // waiter to consume. Single writer per file — the hook only unlinks.
      approval.resolution = { behavior: verdict.behavior, decided_at: new Date().toISOString() };
      this.approvals.put(approval);
    }
    this.log(`approval ${verdict.request_id} resolved: ${verdict.behavior}`);
    return true;
  }

  /** Post the card and block until tap or timeout→deny. */
  async ask(
    conversationId: string,
    askInput: PermissionAsk,
    engine: string,
  ): Promise<PermissionDecision> {
    const requestId = newRequestId();
    const approval: PendingApproval = {
      request_id: requestId,
      conversation_id: conversationId,
      engine,
      tool_name: askInput.toolName,
      created_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + this.timeoutMs).toISOString(),
      options: askInput.options.map((option) => ({
        option_id: option.optionId,
        label: option.label,
        kind: option.kind,
      })),
      source: "acp",
    };
    // Durable (create-once) before the card goes out.
    this.approvals.create(approval);

    const card = buildPermissionCard({
      requestId,
      conversationId,
      engineLabel: engine === "codex" ? "Codex" : engine === "opencode" ? "opencode" : "Claude",
      toolName: askInput.toolName,
      description: askInput.title,
    });
    const posted = await this.client.postMessage(card.body, card.idempotencyKey);
    approval.relay_message_id = posted.message_id;
    this.approvals.put(approval);

    return await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        this.approvals.consume(requestId);
        this.log(`approval ${requestId} timed out → deny`);
        resolve(denyDecision(approval));
      }, this.timeoutMs);
      timer.unref?.();
      this.waiters.set(requestId, { approval, resolve, timer });
    });
  }
}
