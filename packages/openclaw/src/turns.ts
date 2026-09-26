import type { RelayIngressLifecycle } from "./ingress.js";

/**
 * The OpenClaw turns running in each Chat of one Relay account, so another
 * agent's Message can wait for them instead of steering into them.
 *
 * OpenClaw steers a Message that arrives mid-turn into the running turn by
 * default (`messages.queue.mode` "steer", docs/concepts/queue.md), and that
 * turn's answer names the first Message. With `followup` the queued turn's
 * answer names none. Relay's A2A door gives each calling agent only the answer
 * whose `reply_to` names its Message (Relay-Server `a2a.ts` `replyTo`), so the
 * second of two overlapping calls got no answer. A channel plugin "may
 * preserve ordering ... before a message enters the session queue"
 * (docs/concepts/messages.md, Queueing and followups); this is that ordering,
 * the same rule Relay's CLI bridges follow (`replacesLiveTurn`, PR 366): an
 * agent's Message waits its turn, a person's Message is left to OpenClaw.
 */
export type RelayChatTurns = {
  /** Run one dispatch into OpenClaw, recorded as running in its Chat until it settles. */
  track<T>(chatId: string, work: () => Promise<T>): Promise<T>;
  /** Whether a turn runs in the Chat now. */
  busy(chatId: string): boolean;
  /** Resolve once no turn runs in the Chat; reject with the signal's reason. */
  idle(chatId: string, signal?: AbortSignal): Promise<void>;
};

export function createRelayChatTurns(): RelayChatTurns {
  const running = new Map<string, Set<Promise<unknown>>>();
  return {
    track(chatId, work) {
      const turns = running.get(chatId) ?? new Set<Promise<unknown>>();
      running.set(chatId, turns);
      const turn = work();
      turns.add(turn);
      const settle = () => {
        turns.delete(turn);
        if (turns.size === 0 && running.get(chatId) === turns) running.delete(chatId);
      };
      turn.then(settle, settle);
      return turn;
    },
    busy: (chatId) => Boolean(running.get(chatId)?.size),
    async idle(chatId, signal) {
      for (;;) {
        signal?.throwIfAborted();
        const turns = running.get(chatId);
        if (!turns?.size) return;
        const settled = Promise.allSettled([...turns]);
        if (!signal) {
          await settled;
          continue;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void settled.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
        });
      }
    },
  };
}

/**
 * Hold a claimed Relay event until its Chat is idle. The claim is handed off
 * as deferred and kept alive with the drain's own heartbeat
 * (`ChannelIngressDispatchLifecycle.onDeferred` / `onDeferredHeartbeat`,
 * docs/plugins/sdk-channel-outbound.md "Deferred claim heartbeats"), so the
 * adoption watchdog does not retry a Message that is only waiting its turn. On
 * shutdown the wait rejects before adoption, and the drain keeps the event for
 * the next start.
 */
export async function waitForIdleChat(params: {
  turns: RelayChatTurns;
  chatId: string;
  lifecycle: Partial<RelayIngressLifecycle>;
}): Promise<void> {
  const { lifecycle } = params;
  if (!params.turns.busy(params.chatId)) return;
  const signal = lifecycle.abortSignal;
  lifecycle.onDeferred?.();
  const interval = lifecycle.deferredHeartbeatIntervalMs;
  const heartbeat = lifecycle.onDeferredHeartbeat && interval && interval > 0
    ? setInterval(() => lifecycle.onDeferredHeartbeat?.(), interval)
    : undefined;
  heartbeat?.unref?.();
  try {
    await params.turns.idle(params.chatId, signal);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
