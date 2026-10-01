import {
  RICH_CARD_DESCRIPTION_MAX_LENGTH,
  RICH_CARD_MAX_SUGGESTIONS,
  RICH_CARD_TITLE_MAX_LENGTH,
  SELECTION_MAX_OPTIONS,
  SELECTION_TITLE_MAX_LENGTH,
  SUGGESTION_ID_MAX_LENGTH,
  SUGGESTION_LABEL_MAX_LENGTH,
  selectionReply,
  suggestionReply,
  type MessagePart,
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
 * allowlisted DMs (claude-plugins-official-telegram-server.ts.txt); the
 * iMessage plugin sends it to the owner's own chat because "that authority is
 * the owner's alone" (claude-plugins-official-imessage-server.ts.txt). Relay
 * names the owners itself: `GET /v1/me` returns `owner_people` for the calling
 * Agent Token (Relay-Server server/src/me.ts, `app.get("/me")`).
 *
 * The card is a `rich_card` whose reply suggestions are the harness's
 * choices; a tap comes back as the owner's own message, a `suggestion_response`
 * carrying the choice's id and replying to the card. A Pi select with more
 * choices than a card holds is a single-choice `selection` instead, answered
 * by a `selection_response`. A tap from anyone else is not registered, and
 * the card stays open for an owner to answer.
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
  /** The card's title, one sentence; `<harness> asks to use <tool>.` when absent. */
  title?: string;
  /** The command or file the harness wants to use. */
  summary: string;
  /**
   * A plain line under the command: Bash's own description of it, which
   * Claude Code's terminal prompt shows under the command too.
   */
  note?: string;
  /** The full input as a person reads it. */
  detail: string;
  /**
   * Whether `detail` holds anything `summary` and `note` do not: an input
   * field beyond the summarized value and the note. The card then shows
   * `detail` in place of them.
   */
  extra: boolean;
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

/** The one line the terminal shows when nobody can be asked. */
export const noOwnerLine = (request: Pick<ApprovalRequest, "harness" | "tool">): string =>
  `${request.harness} was not allowed to use ${request.tool}: nobody who owns this agent has a Relay app account to approve it. Link a phone from Settings in the Relay console, or with \`relay phone link\`.`;

/** What the reply to the card says once a prompt has ended. */
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

/**
 * The contract's limits (Relay-Server contracts/developer/openapi.yaml), the
 * card's from the SDK; a `SelectionPart` subtitle is 512 characters and an
 * id-bearing `SelectionOption` has a 24-character label and a 200-character id.
 */
export const CARD_LIMITS = {
  title: RICH_CARD_TITLE_MAX_LENGTH,
  description: RICH_CARD_DESCRIPTION_MAX_LENGTH,
  suggestions: RICH_CARD_MAX_SUGGESTIONS,
  label: SUGGESTION_LABEL_MAX_LENGTH,
  replyId: SUGGESTION_ID_MAX_LENGTH,
  selectionTitle: SELECTION_TITLE_MAX_LENGTH,
  selectionSubtitle: 512,
  selectionOptions: SELECTION_MAX_OPTIONS,
  selectionLabel: 24,
  selectionId: 200,
} as const;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** The card's title: the harness's sentence, or `<harness> asks to use <tool>.` */
export const cardTitle = (request: ApprovalRequest): string =>
  oneLine(request.title ?? "") || `${request.harness} asks to use ${request.tool}.`;

/**
 * The card's description, plain text as the app draws it (Relay-iOS
 * RelayRichCardRow.swift, `Text(description)`): the command and its note, or,
 * when the input holds more than them, the whole input as a person reads it.
 * Cut at the contract's 2,000 characters with a closing "…".
 */
export const cardDescription = (request: ApprovalRequest): string | undefined => {
  const text = request.extra
    ? request.detail.trim()
    : [request.summary.trim(), request.note?.trim() ?? ""].filter(Boolean).join("\n\n");
  return text ? clip(text, CARD_LIMITS.description) : undefined;
};

/**
 * The id a choice's reply carries: the harness's own id, unless it is longer
 * than the contract allows, when its place in the list stands in for it.
 */
const replyId = (choice: ApprovalChoice, index: number, max: number): string =>
  choice.id.length <= max ? choice.id : `choice_${index}`;

/** Whether the choices fit on one card's suggestions. */
const onCard = (request: ApprovalRequest): boolean => request.choices.length <= CARD_LIMITS.suggestions;

/**
 * The message part that asks: a `rich_card` with one reply suggestion per
 * choice, or, past the card's 4 suggestions, a single-choice `selection` of up
 * to 25 options.
 */
export const approvalPart = (request: ApprovalRequest): MessagePart => {
  const description = cardDescription(request);
  if (onCard(request)) {
    return {
      type: "rich_card",
      title: clip(cardTitle(request), CARD_LIMITS.title),
      ...(description !== undefined ? { description } : {}),
      suggestions: request.choices.map((choice, index) => ({
        type: "reply" as const,
        label: clip(oneLine(choice.label) || choice.id, CARD_LIMITS.label),
        id: replyId(choice, index, CARD_LIMITS.replyId),
      })),
    };
  }
  return {
    type: "selection",
    title: clip(cardTitle(request), CARD_LIMITS.selectionTitle),
    ...(description !== undefined ? { subtitle: clip(description, CARD_LIMITS.selectionSubtitle) } : {}),
    multiple: false,
    options: request.choices.slice(0, CARD_LIMITS.selectionOptions).map((choice, index) => ({
      id: replyId(choice, index, CARD_LIMITS.selectionId),
      label: clip(oneLine(choice.label) || choice.id, CARD_LIMITS.selectionLabel),
    })),
  };
};

/** The choice a reply id names, as `approvalPart` gave it out. */
export const choiceFor = (request: ApprovalRequest, id: string): ApprovalChoice | undefined => {
  const max = onCard(request) ? CARD_LIMITS.replyId : CARD_LIMITS.selectionId;
  return request.choices.find((choice, index) => replyId(choice, index, max) === id);
};

/**
 * A tap on a card, as `message.received` carries it: the card message it
 * replies to, and the id of the reply the person chose. A card reply is plain
 * text then `suggestion_response`; a picker answer, plain text then
 * `selection_response` (Relay-Server contracts/developer/openapi.yaml,
 * `SuggestionResponsePart` and `SelectionResponsePart`).
 */
export const readAnswer = (event: RelayWebhookEvent): { messageId: string; id: string } | undefined => {
  if (event.event_type !== "message.received") return undefined;
  const parts = event.data.parts ?? [];
  const card = suggestionReply(parts, event.data.reply_to);
  if (card) return { messageId: card.reply_to.message_id, id: card.id };
  const picked = selectionReply(parts, event.data.reply_to);
  const id = picked?.selected_ids?.[0] ?? picked?.selected_values[0];
  return picked && id !== undefined ? { messageId: picked.reply_to.message_id, id } : undefined;
};

/** The Relay calls this needs: who owns the agent, and the chat with each owner. */
export type ApprovalClient = Pick<Relay, "chats" | "me">;

interface Pending {
  request: ApprovalRequest;
  owners: Set<string>;
  /** Each owner's card: its chat and its message. */
  cards: { chatId: string; messageId: string; owner: string }[];
  settle(outcome: ApprovalOutcome): void;
}

export interface OwnerApprovalsOptions {
  client: ApprovalClient;
  say(line: string): void;
}

/**
 * One per bridge process. `ask` sends the card and waits; `take` reads every
 * event first and keeps the answers to its own cards, so they never start a turn.
 */
export class OwnerApprovals {
  readonly #client: ApprovalClient;
  readonly #say: (line: string) => void;
  /** Open prompts, by the message id of each owner's card. */
  readonly #pending = new Map<string, Pending>();
  /** Cards already settled, so a late tap on one is dropped quietly. */
  readonly #settled = new Set<string>();

  constructor(options: OwnerApprovalsOptions) {
    this.#client = options.client;
    this.#say = options.say;
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
    let settle!: (outcome: ApprovalOutcome) => void;
    const done = new Promise<ApprovalOutcome>((resolve) => { settle = resolve; });
    const pending: Pending = { request, owners: new Set(owners.map((owner) => owner.handle)), cards: [], settle };
    const part = approvalPart(request);
    for (const owner of owners) {
      try {
        // The chat between the agent and this owner: Relay reuses the direct
        // chat of the pair (Relay-Server messaging.ts, `createOrReuseChat`).
        const sent = await this.#client.chats.create({
          from: me.handle,
          to: [owner.handle],
          message: { parts: [part] },
        });
        const card = { chatId: sent.chat.id, messageId: sent.chat.message.id, owner: owner.handle };
        pending.cards.push(card);
        this.#pending.set(card.messageId, pending);
      } catch (error) {
        this.#say(`The approval card did not reach @${owner.handle}: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    if (!pending.cards.length) {
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
    for (const card of pending.cards) {
      this.#pending.delete(card.messageId);
      this.#settled.add(card.messageId);
    }
    // The card cannot change once sent, so what happened is a reply to it in
    // every owner's chat.
    await Promise.all(pending.cards.map(async (card) => {
      try {
        await this.#client.chats.messages.send(card.chatId, {
          message: { parts: [{ type: "text", value: outcomeLine(outcome) }], reply_to: { message_id: card.messageId, part_index: 0 } },
        });
      } catch { /* The harness already has its answer; an unanswered card is the lesser harm. */ }
    }));
    this.#say(`${request.tool}: ${outcomeLine(outcome)}`);
    return outcome;
  }

  /**
   * Whether this event is an answer to one of this process's approval cards.
   * Such an event is handled here and must not start a turn.
   */
  async take(event: RelayWebhookEvent): Promise<boolean> {
    const answer = readAnswer(event);
    if (!answer || event.event_type !== "message.received") return false;
    if (this.#settled.has(answer.messageId)) return true;
    const pending = this.#pending.get(answer.messageId);
    if (!pending) return false;
    const sender = event.data.sender_handle;
    // Anyone but an owner is not registered, and the card stays open.
    if (sender.kind !== "user" || !pending.owners.has(sender.handle)) return true;
    const choice = choiceFor(pending.request, answer.id);
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

/** The input field the card's summary shows, in order of preference. */
const summaryKey = (input: Record<string, unknown>): string | undefined =>
  ["command", "cmd", "file_path", "path", "notebook_path", "url", "pattern", "query"].find((key) => {
    const value = input[key];
    return (typeof value === "string" && value.trim() !== "") || (Array.isArray(value) && value.every((part) => typeof part === "string"));
  });

/** One line of a tool input, for the card's summary. */
export const inputSummary = (input: Record<string, unknown>): string => {
  const key = summaryKey(input);
  const value = key === undefined ? undefined : input[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(" ");
  return JSON.stringify(input);
};

/** Whether a value says anything: not absent, false, blank, or empty. */
const says = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

/** Whether an input says anything in a field other than `shown`, the ones the card draws. */
export const beyond = (input: Record<string, unknown>, shown: readonly string[]): boolean =>
  Object.entries(input).some(([key, value]) => !shown.includes(key) && says(value));

/**
 * A tool input as its card shows it: the summarized value, Bash's own
 * description as the note, the readable detail, and whether the input holds
 * more. An input with no field to summarize is summarized whole.
 */
export const inputCard = (input: Record<string, unknown>): Pick<ApprovalRequest, "summary" | "note" | "detail" | "extra"> => {
  const key = summaryKey(input);
  const description = key === "command" && typeof input.description === "string" && input.description.trim() ? input.description : undefined;
  return {
    summary: inputSummary(input),
    ...(description !== undefined ? { note: description } : {}),
    detail: inputDetail(input),
    extra: key !== undefined && beyond(input, description !== undefined ? [key, "description"] : [key]),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isScalar = (value: unknown): boolean => value === null || typeof value !== "object";

/** A value on one line, for an item of a list. */
const inline = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `${key}: ${inline(item)}`).join(", ");
  if (Array.isArray(value)) return value.map(inline).join(", ");
  return String(value);
};

/** One `name: value` line per field; a multi-line value kept as it is, a nested one indented under its name. */
const fields = (input: Record<string, unknown>, indent = ""): string[] =>
  Object.entries(input).filter(([, value]) => value !== undefined).flatMap(([key, value]) => {
    if (isRecord(value)) return [`${indent}${key}:`, ...fields(value, `${indent}  `)];
    if (Array.isArray(value) && !value.every(isScalar)) return [`${indent}${key}:`, ...value.map((item) => `${indent}  - ${inline(item)}`)];
    return [`${indent}${key}: ${inline(value)}`];
  });

/** A replacement as a diff: `-` before each old line, `+` before each new one. */
const diff = (before: string, after: string): string[] => [
  ...before.split("\n").map((line) => `- ${line}`),
  ...after.split("\n").map((line) => `+ ${line}`),
];

const isReplacement = (value: unknown): value is Record<string, unknown> & { old_string: string; new_string: string } =>
  isRecord(value) && typeof value.old_string === "string" && typeof value.new_string === "string";

/**
 * The whole tool input as a person reads it, for the card's description: an Edit is its
 * file and a diff (a MultiEdit, a diff per edit), a Write its file and the
 * content, anything else one `name: value` line per field.
 */
export const inputDetail = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (!isRecord(input)) {
    try { return JSON.stringify(input) ?? String(input); } catch { return String(input); }
  }
  const { file_path: path, ...rest } = input;
  if (typeof path === "string" && isReplacement(input)) {
    const { old_string: _old, new_string: _new, ...other } = rest;
    return [path, ...diff(input.old_string, input.new_string), ...fields(other)].join("\n");
  }
  if (typeof path === "string" && Array.isArray(input.edits) && input.edits.every(isReplacement)) {
    const { edits, ...other } = rest;
    return [
      path,
      ...(edits as { old_string: string; new_string: string }[]).flatMap(({ old_string: before, new_string: after, ...more }) => [...diff(before, after), ...fields(more)]),
      ...fields(other),
    ].join("\n");
  }
  if (typeof path === "string" && typeof input.content === "string") {
    const { content, ...other } = rest;
    return [path, content as string, ...fields(other)].join("\n");
  }
  return fields(input).join("\n");
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
      // The title is the card's first line and the message its summary.
      extra: false,
      choices,
      ...(dialog.timeoutMs !== undefined ? { timeoutMs: dialog.timeoutMs } : {}),
      ...(dialog.signal ? { signal: dialog.signal } : {}),
    });
    return outcome.choice?.id;
  },
  take: (event) => approvals.take(event),
});
