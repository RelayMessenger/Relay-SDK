import Relay from "@relaymessenger/sdk";

const MIN_COMPOSITION_MS = 450;
const MAX_COMPOSITION_MS = 6_000;
/**
 * Human, a little faster than a human (owner's ruling 2026-09-20). The pause
 * stays; every per-character, per-word and per-line term is scaled down, so a
 * long answer no longer sits behind a twelve-second typing indicator.
 */
const COMPOSITION_PACE = 0.75;
export const TYPING_REFRESH_MS = 60_000;

interface RelayTypingClient {
  chats: {
    startTyping(chatId: string): Promise<unknown>;
    stopTyping(chatId: string): Promise<unknown>;
  };
}

export interface RelayTypingLifecycle {
  stop(): Promise<void>;
}

/** The two Worker bindings the Relay client reads. */
export interface RelayClientEnv {
  RELAY_AGENT_TOKEN?: string;
  RELAY_API_ORIGIN?: string;
}

export function createRelayClient(env: RelayClientEnv): Relay {
  if (!env.RELAY_AGENT_TOKEN?.trim()) throw new Error("RELAY_AGENT_TOKEN is not configured");
  return new Relay({
    apiKey: env.RELAY_AGENT_TOKEN,
    baseURL: env.RELAY_API_ORIGIN,
    maxRetries: 2,
    timeout: 15_000,
  });
}

async function bestEffortTyping(
  relay: RelayTypingClient,
  chatId: string,
  operation: "start" | "stop",
): Promise<void> {
  try {
    if (operation === "start") await relay.chats.startTyping(chatId);
    else await relay.chats.stopTyping(chatId);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "relay_agent_typing_failed",
      operation,
      chat_id: chatId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Hold Relay's typing indicator for one complete model turn.
 *
 * Linq's Typing Indicators guide says to start before an AI agent processes a
 * response, refresh every 60 seconds, and explicitly stop when no Message is
 * sent. Relay's turn owner calls stop for every terminal path; a successful
 * send may already have cleared the indicator before that idempotent cleanup.
 */
export async function startRelayTypingLifecycle(
  relay: RelayTypingClient,
  chatId: string,
): Promise<RelayTypingLifecycle> {
  await bestEffortTyping(relay, chatId, "start");

  const refreshController = new AbortController();
  const refreshTask = (async () => {
    while (!refreshController.signal.aborted) {
      try {
        await abortableDelay(
          TYPING_REFRESH_MS,
          refreshController.signal,
        );
      } catch {
        return;
      }
      if (refreshController.signal.aborted) return;
      await bestEffortTyping(relay, chatId, "start");
    }
  })();
  let stopTask: Promise<void> | undefined;

  return {
    stop: () => {
      stopTask ??= (async () => {
        refreshController.abort();
        await refreshTask;
        await bestEffortTyping(relay, chatId, "stop");
      })();
      return stopTask;
    },
  };
}

function countSegments(text: string, granularity: "grapheme" | "word"): number {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segments = new Segmenter("en", { granularity }).segment(text);
    if (granularity === "word") {
      return Array.from(segments).filter((segment) => segment.isWordLike).length;
    }
    return Array.from(segments).length;
  }
  return granularity === "word"
    ? text.trim().split(/\s+/u).filter(Boolean).length
    : Array.from(text).length;
}

function stableUnit(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffff_ffff;
}

export function compositionDelayMs(text: string, stableKey: string): number {
  const graphemes = countSegments(text, "grapheme");
  const words = countSegments(text, "word");
  const punctuation = (text.match(/[,.!?;:…—-]/gu) ?? []).length;
  const lineBreaks = (text.match(/\n/gu) ?? []).length;
  const base = (250
    + graphemes * 22
    + words * 105
    + punctuation * 165
    + lineBreaks * 425) * COMPOSITION_PACE;
  const jitter = 0.92 + stableUnit(`${stableKey}\n${text}`) * 0.16;
  return Math.round(
    Math.min(MAX_COMPOSITION_MS, Math.max(MIN_COMPOSITION_MS, base * jitter)),
  );
}

export async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
