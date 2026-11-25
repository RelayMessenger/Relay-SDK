import { createCompactFunction, isCompactionMessage, type CompactionFunction } from "agents/sessions";
import type { UIMessage } from "ai";

/**
 * Compaction that preserves every person's own words verbatim while
 * summarizing only the agents' Messages with explicit attribution.
 *
 * The summary has two parts:
 * 1. Every Message a person (sender kind `user`) wrote in the range, word for
 *    word and in order. Later compactions carry this block forward verbatim.
 * 2. A model summary of only the agents' Messages, each point attributed to
 *    the agent that made it, as opinions rather than settled decisions.
 */

export const PERSON_HEADING = "## The people's own Messages, word for word";
const PERSON_NOTE =
  "Every Message a person wrote in this part of the conversation, complete and in order. These lines are ground truth: only they say what a person thinks, wants, or decided.";
export const AGENT_HEADING = "## What the agents said (summary)";
const AGENT_NOTE =
  "A summary of the agents' Messages. Each point is that agent's opinion or suggestion, never a person's decision.";
const NO_AGENT_MESSAGES = "(No agent Messages in this part.)";

/** Minimum new conversation (in estimated tokens) before triggering a summary call. */
const MIN_COMPACTED_TOKENS = 50_000;
/** Target length of the agents' summary. */
const AGENT_SUMMARY_MAX_TOKENS = 8_000;
/** Warning threshold for the verbatim person block (nothing is dropped past it). */
export const PERSON_BLOCK_BUDGET_TOKENS = 600_000;

export interface GroupCompactionOptions {
  /** Writes the agents' summary from a prompt (the summary model). */
  summarize: (prompt: string) => Promise<string>;
  keepRecentTokens: number;
  /** How this agent's own Messages are named in the summary. */
  selfName: string;
  /** Overrides MIN_COMPACTED_TOKENS (useful in tests with small conversations). */
  minCompactedTokens?: number;
}

interface SenderHandle {
  display_name?: unknown;
  handle?: unknown;
  kind?: unknown;
}

function relayMessageMeta(message: UIMessage): { sender?: SenderHandle; sentAt?: unknown } {
  const meta = (message.metadata as {
    turnMetadata?: { message?: { sender_handle?: SenderHandle; from_handle?: SenderHandle; sent_at?: unknown } };
  } | undefined)?.turnMetadata?.message;
  return { sender: meta?.from_handle ?? meta?.sender_handle, sentAt: meta?.sent_at };
}

/** A person's Message: Relay's sender kind `user`. */
export function isPersonMessage(message: UIMessage): boolean {
  return message.role === "user" && relayMessageMeta(message).sender?.kind === "user";
}

function senderName(sender: SenderHandle | undefined): string | undefined {
  const name = typeof sender?.display_name === "string" && sender.display_name.trim()
    ? sender.display_name.trim()
    : typeof sender?.handle === "string" && sender.handle.trim() ? sender.handle.trim() : undefined;
  return name;
}

function textOf(message: UIMessage): string {
  return message.parts
    .flatMap((part) => part.type === "text" ? [(part as { text: string }).text] : [])
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sentDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return undefined;
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Format one person's Message as `<Name> [<date>]: <text>`, stripping any
 * leading speaker or time header prefix and indenting continuation lines so
 * user text can never masquerade as a section heading.
 */
export function personLine(message: UIMessage): string {
  const { sender, sentAt } = relayMessageMeta(message);
  const name = senderName(sender) ?? "Person";
  let text = textOf(message);
  const label = new RegExp(`^(?:\\[[^\\]\\n]*\\] )?${escapeRegExp(name)}: `, "u");
  text = text.replace(label, "");
  const date = sentDate(sentAt);
  const [first = "", ...rest] = text.split("\n");
  return [`${name}${date ? ` [${date}]` : ""}: ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

/** An agent's Message as the summary prompt reads it, named by its sender. */
function agentLine(message: UIMessage, selfName: string): string {
  if (message.role === "assistant") {
    const said = message.parts.flatMap((part) => {
      if (part.type === "text") return [(part as { text: string }).text];
      const input = (part as { input?: { text?: unknown } }).input;
      return part.type === "tool-send" && typeof input?.text === "string" ? [input.text] : [];
    }).filter((text) => text.trim());
    return said.length ? `${selfName}: ${said.join("\n")}` : "";
  }
  return textOf(message).replace(/^\[[^\]\n]*\] /u, "");
}

/** Parse the two sections of a rendered group compaction summary. */
export function parseSummary(summary: string): { personBlock: string[]; agentSummary: string } {
  const lines = summary.split("\n");
  const start = lines.indexOf(PERSON_HEADING);
  const end = lines.indexOf(AGENT_HEADING);
  if (start !== 0 || end < start) return { personBlock: [], agentSummary: summary.trim() };
  const personBlock = lines.slice(start + 1, end)
    .filter((line, index) => !(index === 0 && line === PERSON_NOTE))
    .join("\n").trim();
  const agentSummary = lines.slice(end + 1)
    .filter((line, index) => !(index === 0 && line === AGENT_NOTE))
    .join("\n").trim();
  return {
    personBlock: personBlock ? [personBlock] : [],
    agentSummary: agentSummary === NO_AGENT_MESSAGES ? "" : agentSummary,
  };
}

export function agentSummaryPrompt(lines: string[], previous: string, budget: number): string {
  return [
    "Summarize what the AI agents said in a chat with people. The people's own Messages are kept word for word elsewhere and are not shown here. Below are only the agents' Messages; each starts with the agent's name.",
    "",
    "Rules:",
    "- Attribute every point to the agent that made it: \"<agent> argued ...\", \"<agent> suggested ...\".",
    "- An agent's view is an opinion or a suggestion. Never write that anything was decided, agreed, settled, locked or concluded, and never write a suggestion as a plan.",
    "- Do not say what a person thinks, wants or decided: you cannot see their Messages.",
    "- Do not restate facts about the people, their money, their company or their plans, even when an agent repeated them: those live only in the people's own words.",
    "- Include only what was said. Do not invent details.",
    "",
    ...(previous ? ["SUMMARY OF THE AGENTS' EARLIER MESSAGES (keep what is still relevant):", previous, ""] : []),
    "AGENTS' MESSAGES:",
    lines.join("\n\n"),
    "",
    `Write only the summary body, grouped by topic, about ${budget} tokens.`,
  ].join("\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderSummary(personBlock: string[], agentSummary: string): string {
  return [
    PERSON_HEADING,
    PERSON_NOTE,
    "",
    personBlock.length ? personBlock.join("\n") : "(No person Messages in this part.)",
    "",
    AGENT_HEADING,
    AGENT_NOTE,
    "",
    agentSummary.trim() || NO_AGENT_MESSAGES,
  ].join("\n");
}

export function createGroupCompactFunction(options: GroupCompactionOptions): CompactionFunction {
  const range = createCompactFunction({ keepRecentTokens: options.keepRecentTokens, summarize: async () => "range" });
  return async (messages) => {
    const picked = await range(messages);
    if (!picked) return null;
    const from = messages.findIndex((message) => message.id === picked.fromMessageId);
    const to = messages.findIndex((message) => message.id === picked.toMessageId);
    if (from < 0 || to < from) return null;
    const middle = (messages.slice(from, to + 1) as UIMessage[]).filter((message) => !isCompactionMessage(message));
    if (estimateTokens(JSON.stringify(middle)) < (options.minCompactedTokens ?? MIN_COMPACTED_TOKENS)) return null;
    const earlier = messages.find(isCompactionMessage) as UIMessage | undefined;
    const previous = earlier ? parseSummary(textOf(earlier)) : { personBlock: [], agentSummary: "" };

    const personLines = middle.filter(isPersonMessage).map(personLine);
    const agentLines = middle.filter((message) => !isPersonMessage(message))
      .map((message) => agentLine(message, options.selfName))
      .filter((line) => line.trim());
    const budget = Math.min(AGENT_SUMMARY_MAX_TOKENS, Math.max(100, Math.floor(estimateTokens(agentLines.join("\n")) * 0.2)));
    const agentSummary = agentLines.length
      ? (await options.summarize(agentSummaryPrompt(agentLines, previous.agentSummary, budget))).trim()
      : previous.agentSummary;
    if (agentLines.length && !agentSummary) return null;

    const personBlock = [...previous.personBlock, ...personLines];
    const summary = renderSummary(personBlock, agentSummary);
    const personTokens = estimateTokens(personBlock.join("\n"));
    console.log(JSON.stringify({
      event: "relay_compaction",
      compacted_messages: middle.length,
      person_messages: personLines.length,
      person_block_tokens: personTokens,
      summary_tokens: estimateTokens(summary),
    }));
    if (personTokens > PERSON_BLOCK_BUDGET_TOKENS) {
      console.warn(JSON.stringify({
        event: "relay_compaction_person_block_over_budget",
        person_block_tokens: personTokens,
      }));
    }
    return { fromMessageId: picked.fromMessageId, toMessageId: picked.toMessageId, summary };
  };
}
