import type { RelayClient } from "./client.js";
import { RelayApiError, isAbortError } from "./errors.js";
import type { EventDedupe } from "./memory-dedupe.js";
import type {
  MessageReceivedEvent,
  RelayEventEnvelope,
  RelayMessage,
  RelayOutgoingPart,
  RelayReplyTarget,
  RelaySendResult,
} from "./types.js";

const TRANSIENT_BASE_DELAY_MS = 500;
const TRANSIENT_MAX_DELAY_MS = 30_000;

/**
 * What a quoting reply should point at: the target's first part, by its
 * permanent id. A reply is a pointer, so the client that renders it draws the
 * quote from the target message it already holds.
 */
function replyTarget(message: RelayMessage): RelayReplyTarget {
  const partId = message.parts[0]?.part_id;
  return partId
    ? { message_id: message.id, part_id: partId }
    : { message_id: message.id };
}

export type ReplyOptions = {
  /**
   * Render the reply as a quoted reply bubble referencing the inbound message.
   * Off by default: plain sends match the shipped OpenClaw integration.
   */
  quote?: boolean;
};

export type MessageHandlerContext = {
  event: MessageReceivedEvent;
  message: RelayMessage;
  client: RelayClient;
  reply: {
    text: (text: string, options?: ReplyOptions) => Promise<RelaySendResult>;
    parts: (
      parts: RelayOutgoingPart[],
      options?: ReplyOptions,
    ) => Promise<RelaySendResult>;
  };
  typing: (started?: boolean) => Promise<void>;
};

export type PollLoopParams = {
  client: RelayClient;
  getCursor: () => number;
  setCursor: (cursor: number) => void | Promise<void>;
  dedupe: EventDedupe;
  onMessage: (ctx: MessageHandlerContext) => Promise<void> | void;
  /** Drop events whose sender is not allowed. Default: allow all users. */
  allowSender?: (senderId: string) => boolean;
  shouldProcess?: (event: RelayEventEnvelope) => boolean;
  timeoutSeconds?: number;
  limit?: number;
  abortSignal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isMessageReceived(event: RelayEventEnvelope): event is MessageReceivedEvent {
  return (
    event.event_type === "message.received" &&
    typeof event.data === "object" &&
    event.data !== null &&
    "id" in event.data &&
    "parts" in event.data
  );
}

function buildContext(
  client: RelayClient,
  event: MessageReceivedEvent,
): MessageHandlerContext {
  const message = event.data;

  return {
    event,
    message,
    client,
    reply: {
      text: async (text, options) => client.sendText({
        chatId: message.chat_id,
        text,
        ...(options?.quote ? { replyTo: replyTarget(message) } : {}),
      }),
      parts: async (parts, options) => client.sendMessage({
        chatId: message.chat_id,
        parts,
        ...(options?.quote ? { replyTo: replyTarget(message) } : {}),
      }),
    },
    typing: async (started = true) => {
      await client.setTyping({ chatId: message.chat_id, started });
    },
  };
}

/**
 * Receive loop for hosts that cannot expose a public webhook URL.
 *
 * A plain pull of the agent's event log. It coexists with webhooks, holds no
 * exclusive consumer slot, and has nothing to reconcile: a cursor that falls
 * behind just reads more events. Delivery is at least once, so `dedupe`
 * decides what has already been handled.
 */
export async function runPollLoop(params: PollLoopParams): Promise<void> {
  const signal = params.abortSignal ?? new AbortController().signal;
  const sleep = params.sleep ?? defaultSleep;
  const random = params.random ?? Math.random;
  const log = params.log ?? (() => {});
  let transientAttempts = 0;

  const transientDelayMs = () => {
    const backoff = Math.min(
      TRANSIENT_MAX_DELAY_MS,
      TRANSIENT_BASE_DELAY_MS * 2 ** Math.min(transientAttempts, 6),
    );
    return backoff + Math.floor(random() * 250);
  };

  while (!signal.aborted) {
    let page;
    try {
      page = await params.client.pollEvents({
        after: params.getCursor(),
        timeoutSeconds: params.timeoutSeconds ?? 30,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      if (error instanceof RelayApiError && error.terminal) {
        // Retrying cannot fix these; surface them to the operator.
        log(`[relay] poll failed permanently: ${error.message}`);
        throw error;
      }
      transientAttempts += 1;
      log(`[relay] transient poll error (attempt ${transientAttempts}): ${String(error)}`);
      await sleep(transientDelayMs(), signal);
      continue;
    }

    transientAttempts = 0;

    for (const event of page.events) {
      if (params.shouldProcess && !params.shouldProcess(event)) continue;
      if (!isMessageReceived(event)) continue;
      if (params.dedupe.has(event.event_id)) continue;

      const sender = event.data.sender_handle;
      if (sender.kind === "agent") continue;
      if (params.allowSender && !params.allowSender(sender.id)) {
        params.dedupe.record(event.event_id);
        continue;
      }

      const ctx = buildContext(params.client, event);
      try {
        await params.onMessage(ctx);
        params.dedupe.record(event.event_id);
      } catch (error) {
        log(`[relay] handler failed for ${event.event_id}: ${String(error)}`);
        throw error;
      }
    }

    await params.setCursor(page.nextCursor);
  }
}
