import type { ModelMessage } from "ai";

/**
 * Bound the chat history one turn sends to the model (owner's ruling
 * 2026-09-20). Newest Messages are kept, oldest are dropped whole.
 *
 * Neither Think nor the Chat SDK ships a token counter: Think says the app
 * owns that mapping, because only the app knows its provider and model
 * (`@cloudflare/think/dist/think.js:2972`). So this is the four-characters-per
 * -token estimate, counted over text only. File and image parts carry bytes,
 * not text, and Gemini bills them on its own schedule, so their base64 length
 * would make one inbound photo look like a full history.
 */
const CHARS_PER_TOKEN = 4;
export const MAX_HISTORY_TOKENS = 100_000;

function partCharacters(part: unknown): number {
  if (typeof part !== "object" || part === null) return 0;
  const candidate = part as {
    type?: unknown;
    text?: unknown;
    input?: unknown;
    output?: unknown;
  };
  if (typeof candidate.text === "string") return candidate.text.length;
  if (candidate.type === "tool-call") return JSON.stringify(candidate.input ?? "").length;
  if (candidate.type === "tool-result") return JSON.stringify(candidate.output ?? "").length;
  return 0;
}

export function historyTokens(message: ModelMessage): number {
  const content = message.content;
  const characters = typeof content === "string"
    ? content.length
    : Array.isArray(content)
    ? content.reduce<number>((total, part) => total + partCharacters(part), 0)
    : 0;
  return Math.ceil(characters / CHARS_PER_TOKEN);
}

/**
 * Keep the newest Messages inside the token budget.
 *
 * The newest Message is the one being answered, so it is always kept, however
 * long it is. A tool result left at the head after a cut has lost the
 * assistant tool call it answers; Vertex rejects that pair, so those orphans
 * are dropped too.
 */
export function capHistoryTokens(
  messages: readonly ModelMessage[],
  maxTokens: number = MAX_HISTORY_TOKENS,
): ModelMessage[] {
  if (messages.length === 0) return [];
  let tokens = 0;
  let first = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const next = tokens + historyTokens(messages[index]!);
    if (index < messages.length - 1 && next > maxTokens) break;
    tokens = next;
    first = index;
  }
  while (first < messages.length - 1 && messages[first]!.role === "tool") {
    tokens -= historyTokens(messages[first]!);
    first += 1;
  }
  if (first === 0) return [...messages];
  console.log(JSON.stringify({
    event: "relay_history_capped",
    max_tokens: maxTokens,
    dropped: first,
    kept: messages.length - first,
    kept_tokens: tokens,
  }));
  return messages.slice(first);
}

/**
 * The history without Gemini's thought signatures on turns before the one
 * being answered. A signature carries the model's hidden reasoning into the
 * next request ("required to maintain reasoning continuity across multi-turn
 * interactions", ai.google.dev/gemini-api/docs/thinking#signatures); the
 * current turn's own steps keep theirs, which Gemini needs for its function
 * calls. Every word and tool call stays.
 *
 * Measured 2026-09-28 against staging's gateway (gemini-3.8-flash, @uncray's
 * prompt and Actions, 4 earlier turns made at medium, then "hey how are you
 * today" at `low`, 3 trials each): with the 8 earlier signatures it thought
 * 421-564 tokens, 5.2-5.7 s; without them 0 tokens, 1.8-2.5 s, and Gemini
 * accepted the request. Live persona chats thought 200-1,600 tokens at `low`.
 */
export function withoutPastThoughtSignatures(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  let current = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") {
      current = index;
      break;
    }
  }
  return messages.map((message, index) => {
    if (index >= current || message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (!("providerOptions" in part) || !part.providerOptions) return part;
        const options = part.providerOptions;
        let changed = false;
        const next: typeof options = {};
        for (const [provider, values] of Object.entries(options)) {
          if (values && typeof values === "object" && "thoughtSignature" in values) {
            const { thoughtSignature: _signature, ...rest } = values as Record<string, unknown>;
            changed = true;
            if (Object.keys(rest).length) next[provider] = rest as typeof values;
          } else {
            next[provider] = values;
          }
        }
        if (!changed) return part;
        const { providerOptions: _options, ...bare } = part;
        return (Object.keys(next).length ? { ...bare, providerOptions: next } : bare) as typeof part;
      }),
    } as ModelMessage;
  });
}
