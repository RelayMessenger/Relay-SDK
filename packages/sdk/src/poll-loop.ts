import type { RelayClient } from "./client.js";
import { RelayApiError, isAbortError } from "./errors.js";
import { replyIdempotencyKey } from "./idempotency.js";
import type { EventDedupe } from "./memory-dedupe.js";
import { isVisibleMessage } from "./types.js";
import type {
  MessageReceivedData,
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
 * What a quoting reply should point at.
 *
 * Prefer the target's first part's stable `part_id`: it keeps naming that part
 * after an edit reorders or removes it, where `part_index: 0` would follow the
 * slot and silently come to mean a different part. The index is the fallback
 * for a payload stored before part identities existed, which `/v1/events`
 * still replays verbatim.
 */
function quoteTarget(message: RelayMessage): RelayReplyTarget {
  const partId = isVisibleMessage(message) ? message.parts[0]?.part_id : undefined;
  return partId
    ? { message_id: message.id, part_id: partId }
    : { message_id: message.id, part_index: 0 };
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
  message: MessageReceivedData["message"];
  invocationId?: string;
  client: RelayClient;
  reply: {
    text: (text: string, options?: ReplyOptions) => Promise<RelaySendResult>;
    parts: (
      parts: RelayOutgoingPart[],
      options?: ReplyOptions,
    ) => Promise<RelaySendResult>;
  };
  responding: (label?: string) => Promise<void>;
  typing: (started?: boolean, label?: string) => Promise<void>;
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
    "message" in event.data &&
    typeof (event.data as MessageReceivedData).message === "object"
  );
}

function buildContext(
  client: RelayClient,
  event: MessageReceivedEvent,
): MessageHandlerContext {
  const message = event.data.message;
  const invocationId = event.data.invocation_id;
  let ordinal = 0;

  const ctx: MessageHandlerContext = {
    event,
    message,
    client,
    reply: {
      text: async (text, options) => {
        const key = replyIdempotencyKey(event.event_id, String(ordinal++));
        return client.sendText({
          conversationId: message.conversation_id,
          text,
          idempotencyKey: key,
          ...(invocationId ? { invocationId } : {}),
          ...(options?.quote ? { replyTo: quoteTarget(message) } : {}),
        });
      },
      parts: async (parts, options) => {
        const key = replyIdempotencyKey(event.event_id, String(ordinal++));
        return client.sendMessage({
          conversationId: message.conversation_id,
          parts,
          idempotencyKey: key,
          ...(invocationId ? { invocationId } : {}),
          ...(options?.quote ? { replyTo: quoteTarget(message) } : {}),
        });
      },
    },
    responding: async (label) => {
      await client.setResponding({
        conversationId: message.conversation_id,
        messageId: message.id,
        ...(label ? { label } : {}),
        ...(invocationId ? { invocationId } : {}),
      });
    },
    typing: async (started = true, label) => {
      await client.setTyping({
        conversationId: message.conversation_id,
        started,
        ...(label ? { label } : {}),
        ...(invocationId ? { invocationId } : {}),
      });
    },
  };
  if (invocationId) ctx.invocationId = invocationId;
  return ctx;
}

/**
 * Long-poll receive loop for hosts that cannot expose a public webhook URL.
 * Webhooks and long polling are mutually exclusive per Agent Token.
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
        cursor: params.getCursor(),
        timeoutSeconds: params.timeoutSeconds ?? 30,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      if (error instanceof RelayApiError && error.terminal) {
        // Retrying cannot fix these; surface them to the operator.
        if (error.status === 410) {
          log(
            "[relay] cursor expired (410): the cursor is behind the seven-day " +
              "retention ceiling. Reconcile from conversation history; do not " +
              "reset the cursor to zero.",
          );
        } else if (error.status === 422) {
          const highest = error.details?.["highest_delivered_cursor"];
          log(
            "[relay] cursor ahead of the delivered ledger (422): reconcile " +
              "history over REST, then resume from " +
              (highest === undefined
                ? "error.details.highest_delivered_cursor."
                : `cursor ${String(highest)}.`),
          );
        } else if (error.kind === "conflict") {
          log(`[relay] long poll conflict: ${error.message}`);
        }
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

      const sender = event.data.message.sender;
      if (sender.kind === "agent") continue;
      if (params.allowSender && sender.kind === "user" && !params.allowSender(sender.id)) {
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
