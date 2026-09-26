import { randomUUID } from "node:crypto";
import {
  A2UI_VERSION,
  RELAY_A2UI_CATALOG_ID,
  a2uiPart,
  readA2uiAction,
  updateA2uiSurface,
  type A2uiComponent,
  type A2uiServerToClientMessage,
  type OwnerPerson,
  type Relay,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";
import type { PiApprovals } from "@relaymessenger/pi";

/**
 * Relays a coding agent's own permission prompts to the people who own the
 * Relay agent, as a card in each owner's chat with the agent.
 *
 * The harness decides what needs a person's yes; this process only carries
 * the question and the answer. That is how every integration of a messenger
 * with a coding agent does it: Claude Code's channels relay the harness's
 * permission prompt and let the harness apply the verdict (Claude Code
 * channels reference, "Relay permission prompts"; saved at
 * _sources/approvals-inkbox-20260926/claude-code-channels-reference.md), and
 * Inkbox's Claude Code and Codex plugins forward each `can_use_tool` and
 * `requestApproval` to the human (inkbox-claude-code-plugin-sessions.py.txt
 * `_can_use_tool`; inkbox-codex-plugin-codex_client.py.txt
 * `_handle_server_request`).
 *
 * Only an owner answers. The official Telegram plugin sends the prompt only to
 * allowlisted DMs and answers anyone else who taps "Not authorized."
 * (claude-plugins-official-telegram-server.ts.txt); the iMessage plugin sends
 * it to the owner's own chat because "that authority is the owner's alone"
 * (claude-plugins-official-imessage-server.ts.txt). Relay names the owners
 * itself: `GET /v1/me` returns `owner_people` for the calling Agent Token
 * (Relay-Server server/src/me.ts, `app.get("/me")`).
 */

/**
 * How a person may answer, in the words every harness maps to. `choice` is an
 * option of a question that is neither an allow nor a deny (a Pi extension's
 * `select`).
 */
export type ApprovalDecision = "allow_once" | "allow_session" | "deny" | "choice";

/** One choice the harness offers, with the label the card shows. */
export interface ApprovalChoice {
  /** The harness's own id for the choice, handed back to it unchanged. */
  id: string;
  label: string;
  decision: ApprovalDecision;
}

/** One permission prompt from a harness. */
export interface ApprovalRequest {
  /** Who is asking, e.g. "Claude Code". */
  harness: string;
  /** The tool it wants to use, e.g. "Bash". */
  tool: string;
  /** The card's first line, one sentence; `<harness> asks to use <tool>.` when absent. */
  title?: string;
  /** The command or file, in one line. */
  summary: string;
  /** The full input, shown under "See more". */
  detail: string;
  /** The harness's own choices, allow first. */
  choices: readonly ApprovalChoice[];
  /**
   * How long to wait for an answer. The harness's own timeout when it sets
   * one (Codex's `autoResolutionMs`); otherwise `APPROVAL_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** Stops the wait, for example when the turn is cancelled. */
  signal?: AbortSignal;
}

/** How a prompt ended. With no `choice`, the harness is told no. */
export interface ApprovalOutcome {
  choice?: ApprovalChoice;
  /** The owner who answered. */
  by?: string;
  reason: "answered" | "timeout" | "no_owner" | "unsent" | "aborted";
}

/**
 * Inkbox waits 600 seconds for a person's answer and then treats the request
 * as not approved (`permission_timeout_s: float = 600.0`,
 * inkbox-claude-code-plugin-config.py.txt:108 and
 * inkbox-codex-plugin-config.py.txt:132).
 */
export const APPROVAL_TIMEOUT_MS = 600_000;

/** The Button event every answer on the card carries. */
export const ANSWER_EVENT = "approval_answer";
/** The Modal trigger's event: it opens "See more" on the phone and asks nothing. */
export const SEE_MORE_EVENT = "approval_see_more";

/** The line an owner who taps someone else's card reads (the Telegram plugin's words). */
export const NOT_AUTHORIZED = "Not authorized.";

/** The one line the terminal shows when nobody can be asked. */
export const noOwnerLine = (request: Pick<ApprovalRequest, "harness" | "tool">): string =>
  `${request.harness} was not allowed to use ${request.tool}: nobody who owns this agent has a Relay app account to approve it. Link a phone from Settings in the Relay console, or with \`relay phone link\`.`;

/** What the card says once a prompt has ended. */
export const outcomeLine = (outcome: ApprovalOutcome): string => {
  const who = outcome.by ? `@${outcome.by}` : "Someone";
  switch (outcome.choice?.decision) {
    case "allow_once": return `${who} allowed this once.`;
    case "allow_session": return `${who} allowed this for this session.`;
    case "deny": return `${who} denied this.`;
    case "choice": return `${who} chose ${outcome.choice.label}.`;
    default: break;
  }
  if (outcome.reason === "timeout") return "Timed out, not approved.";
  return "Not approved.";
};

const MAX_SUMMARY = 300;
const MAX_DETAIL = 4_000;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * A command or path as a Markdown code span, which A2UI's Text renders
 * ("simple Markdown formatting is supported", basic catalog `Text.text`), so
 * a `*` or `_` in a command is shown, not read as emphasis. The fence is one
 * backtick longer than the longest run inside (CommonMark, "Code spans").
 */
export const codeSpan = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** The card's first lines: the sentence, and the command or file when there is one. */
const head = (request: ApprovalRequest): string[] => oneLine(request.summary) ? ["title", "summary"] : ["title"];

/** The card's components, before any answer. */
export const approvalComponents = (request: ApprovalRequest): A2uiComponent[] => {
  const buttons = request.choices.map((choice, index) => ({ choice, id: `choice_${index}` }));
  return [
    { id: "root", component: "Card", child: "body" },
    { id: "body", component: "Column", children: [...head(request), "more", "answers"] },
    { id: "title", component: "Text", text: request.title ?? `${request.harness} asks to use ${request.tool}.`, variant: "h4" },
    ...(oneLine(request.summary) ? [{ id: "summary", component: "Text", text: codeSpan(clip(oneLine(request.summary), MAX_SUMMARY)) }] : []),
    { id: "more", component: "Modal", trigger: "more_button", content: "more_sheet" },
    { id: "more_button", component: "Button", child: "more_label", variant: "borderless", action: { event: { name: SEE_MORE_EVENT } } },
    { id: "more_label", component: "Text", text: "See more" },
    { id: "more_sheet", component: "Column", children: ["more_title", "more_text"] },
    { id: "more_title", component: "Text", text: request.tool, variant: "h4" },
    { id: "more_text", component: "Text", text: clip(request.detail, MAX_DETAIL) },
    { id: "answers", component: "Column", children: buttons.map((button) => button.id) },
    ...buttons.flatMap(({ choice, id }, index) => [
      {
        id,
        component: "Button",
        child: `${id}_label`,
        ...(index === 0 ? { variant: "primary" } : {}),
        action: { event: { name: ANSWER_EVENT, context: { choice: choice.id } } },
      },
      { id: `${id}_label`, component: "Text", text: choice.label },
    ]),
  ];
};

/** The card after the prompt ended: the buttons give way to what happened. */
export const settledComponents = (request: ApprovalRequest, outcome: ApprovalOutcome): A2uiComponent[] => [
  { id: "body", component: "Column", children: [...head(request), "more", "outcome"] },
  { id: "outcome", component: "Text", text: outcomeLine(outcome), variant: "caption" },
];

/** The A2UI messages of a new card: `createSurface` then `updateComponents` (Relay-Docs interactions/cards.mdx, "Send a card"). */
export const approvalMessages = (surfaceId: string, request: ApprovalRequest): A2uiServerToClientMessage[] => [
  { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: RELAY_A2UI_CATALOG_ID } },
  { version: A2UI_VERSION, updateComponents: { surfaceId, components: approvalComponents(request) } },
];

/** The Relay calls this needs: who owns the agent, and the chat with each owner. */
export type ApprovalClient = Pick<Relay, "chats" | "me">;

interface Pending {
  request: ApprovalRequest;
  owners: Set<string>;
  /** The chat each owner's card is in. */
  cards: { chatId: string; owner: string }[];
  settle(outcome: ApprovalOutcome): void;
}

export interface OwnerApprovalsOptions {
  client: ApprovalClient;
  say(line: string): void;
  /** A new surface id; random unless a test pins it. */
  surfaceId?: () => string;
}

/**
 * One per bridge process. `ask` sends the card and waits; `take` reads every
 * event first and keeps the taps on its own cards, so they never start a turn.
 */
export class OwnerApprovals {
  readonly #client: ApprovalClient;
  readonly #say: (line: string) => void;
  readonly #surfaceId: () => string;
  readonly #pending = new Map<string, Pending>();
  /** Cards already settled, so a late tap on one is dropped quietly. */
  readonly #settled = new Set<string>();

  constructor(options: OwnerApprovalsOptions) {
    this.#client = options.client;
    this.#say = options.say;
    this.#surfaceId = options.surfaceId ?? (() => `approval-${randomUUID()}`);
  }

  async ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return { reason: "aborted" };
    // Read fresh each time, so an owner who links a phone while the bridge
    // runs is asked from the next prompt on.
    let me: Awaited<ReturnType<ApprovalClient["me"]["retrieve"]>>;
    try {
      me = await this.#client.me.retrieve();
    } catch (error) {
      this.#say(`${request.harness} was not allowed to use ${request.tool}: Relay did not say who owns this agent (${error instanceof Error ? error.message : String(error)}).`);
      return { reason: "unsent" };
    }
    const owners: OwnerPerson[] = me.owner_people ?? [];
    if (!owners.length) {
      this.#say(noOwnerLine(request));
      return { reason: "no_owner" };
    }
    const surfaceId = this.#surfaceId();
    let settle!: (outcome: ApprovalOutcome) => void;
    const done = new Promise<ApprovalOutcome>((resolve) => { settle = resolve; });
    const pending: Pending = { request, owners: new Set(owners.map((owner) => owner.handle)), cards: [], settle };
    this.#pending.set(surfaceId, pending);
    for (const owner of owners) {
      try {
        // The chat between the agent and this owner: Relay reuses the direct
        // chat of the pair (Relay-Server messaging.ts, `createOrReuseChat`).
        const sent = await this.#client.chats.create({
          from: me.handle,
          to: [owner.handle],
          message: { parts: [a2uiPart(approvalMessages(surfaceId, request))] },
        });
        pending.cards.push({ chatId: sent.chat.id, owner: owner.handle });
      } catch (error) {
        this.#say(`The approval card did not reach @${owner.handle}: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    if (!pending.cards.length) {
      this.#pending.delete(surfaceId);
      this.#say(`${request.harness} was not allowed to use ${request.tool}: no owner could be asked.`);
      return { reason: "unsent" };
    }
    this.#say(`Asked ${pending.cards.map((card) => `@${card.owner}`).join(", ")} to approve ${request.tool}.`);
    const timeoutMs = request.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    const timer = setTimeout(() => settle({ reason: "timeout" }), timeoutMs);
    const abort = (): void => settle({ reason: "aborted" });
    request.signal?.addEventListener("abort", abort, { once: true });
    const outcome = await done;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    this.#pending.delete(surfaceId);
    this.#settled.add(surfaceId);
    await Promise.all(pending.cards.map(async (card) => {
      try {
        await updateA2uiSurface(this.#client, card.chatId, surfaceId, { components: settledComponents(request, outcome) });
      } catch { /* The harness already has its answer; a stale card is the lesser harm. */ }
    }));
    this.#say(`${request.tool}: ${outcomeLine(outcome)}`);
    return outcome;
  }

  /**
   * Whether this event is a tap on one of this process's approval cards.
   * Such an event is handled here and must not start a turn.
   */
  async take(event: RelayWebhookEvent): Promise<boolean> {
    if (event.event_type !== "message.received") return false;
    const tap = readA2uiAction(event);
    if (!tap) return false;
    const surfaceId = tap.action.surfaceId;
    if (this.#settled.has(surfaceId)) return true;
    const pending = this.#pending.get(surfaceId);
    if (!pending) return false;
    if (tap.action.name !== ANSWER_EVENT) return true;
    const sender = event.data.sender_handle;
    const chatId = event.data.chat.id;
    if (sender.kind !== "user" || !pending.owners.has(sender.handle)) {
      try {
        await this.#client.chats.messages.send(chatId, { message: { parts: [{ type: "text", value: NOT_AUTHORIZED }] } });
      } catch { /* Refusing is what matters; the note is a courtesy. */ }
      this.#say(`@${sender.handle} is not an owner of this agent, so their answer to ${pending.request.tool} was ignored.`);
      return true;
    }
    const choice = pending.request.choices.find((option) => option.id === tap.action.context.choice);
    if (!choice) return true;
    pending.settle({ reason: "answered", choice, by: sender.handle });
    return true;
  }
}

/** What a harness is told when a prompt ends without an allow (Inkbox's words, sessions.py.txt:1249). */
export const denialMessage = (outcome: ApprovalOutcome): string => {
  switch (outcome.reason) {
    case "timeout": return "The agent's owner did not answer in time, so treating that as not approved.";
    case "no_owner": return "Nobody who owns this agent can be asked, so treating that as not approved.";
    case "unsent": return "The agent's owner could not be asked, so treating that as not approved.";
    case "aborted": return "The request was cancelled, so treating that as not approved.";
    default: return "The agent's owner denied this, so treating that as not approved.";
  }
};

/** One line of a tool input, for the card's summary. */
export const inputSummary = (input: Record<string, unknown>): string => {
  for (const key of ["command", "cmd", "file_path", "path", "notebook_path", "url", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return JSON.stringify(input);
};

/** The whole tool input, for "See more". */
export const inputDetail = (input: unknown): string => {
  try { return JSON.stringify(input, null, 2) ?? String(input); } catch { return String(input); }
};

/**
 * Pi's dialogs, answered by the owners. A confirm is Yes or No, an allow and
 * a deny; a select offers the extension's own options, each as it wrote it.
 * The card's first line is the extension's own title.
 */
export const piApprovals = (approvals: Pick<OwnerApprovals, "ask" | "take">): PiApprovals => ({
  dialog: async (dialog) => {
    const choices: ApprovalChoice[] = dialog.method === "confirm"
      ? [{ id: "Yes", label: "Yes", decision: "allow_once" }, { id: "No", label: "No", decision: "deny" }]
      : dialog.options.map((option) => ({ id: option, label: option, decision: "choice" }));
    const outcome = await approvals.ask({
      harness: "Pi",
      tool: oneLine(dialog.title).slice(0, 80) || "a question",
      title: dialog.title.trim() || "Pi asks a question.",
      summary: dialog.message ?? "",
      detail: [dialog.title, dialog.message].filter(Boolean).join("\n\n"),
      choices,
      ...(dialog.timeoutMs !== undefined ? { timeoutMs: dialog.timeoutMs } : {}),
      ...(dialog.signal ? { signal: dialog.signal } : {}),
    });
    return outcome.choice?.id;
  },
  take: (event) => approvals.take(event),
});
