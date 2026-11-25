import type Relay from "@relaymessenger/sdk";
import type { OwnerApprovals } from "./approvals.js";
import { bridgeTurn, replacesLiveTurn, type BridgeTurn } from "./bridge-turn.js";

/** One line of what arrived, short enough to read at a glance. */
export const formatBridgeArrival = (turn: BridgeTurn): string =>
  `@${turn.sender}  ${turn.text.replace(/\s+/gu, " ").slice(0, 160)}`;

/** Start the typing indicator for a chat and return an idempotent stopper. */
export const startBridgeTyping = async (
  client: Pick<Relay, "chats">,
  chatId: string,
): Promise<() => Promise<void>> => {
  let typing = false;
  try {
    await client.chats.startTyping(chatId);
    typing = true;
  } catch { /* The answer matters more than the typing indicator. */ }
  return async (): Promise<void> => {
    if (!typing) return;
    typing = false;
    try { await client.chats.stopTyping(chatId); } catch { /* As above. */ }
  };
};

/** Minimum shape of an active turn managed by a bridge chat lane. */
export interface BridgeLiveTurn {
  /** A newer message for this chat replaced it, so its answer is not sent. */
  dropped: boolean;
}

/** What one chat has running, and what is waiting behind it. */
export interface BridgeChatLane<TLive extends BridgeLiveTurn> {
  /** Turns in one chat run one after another, in the order the messages arrived. */
  chain: Promise<void>;
  live?: TLive | undefined;
  /** Whether the live turn answers another agent (`replacesLiveTurn`). */
  liveFromAgent?: boolean | undefined;
}

export interface BridgeEventLoopOptions<TLive extends BridgeLiveTurn> {
  client: Pick<Relay, "websocket">;
  approvals: Pick<OwnerApprovals, "take">;
  signal: AbortSignal;
  say(line: string): void;
  /** Harness label shown on full-sync recovery notices. */
  label: string;
  /** Skip events once `signal.aborted` is true. */
  ignoreWhenAborted?: boolean;
  /** Interrupt a running turn when replaced by a newer person message. */
  interrupt(live: TLive): Promise<void> | void;
  /** Execute one turn in its serialized chat lane and call `started()` once active. */
  answer(turn: BridgeTurn, lane: BridgeChatLane<TLive>, started: () => void): Promise<void>;
}

/**
 * Shared Relay WebSocket event loop and per-chat serialized turn-lane queue
 * for long-lived coding-agent bridges (Codex, ACP, Claude Code).
 *
 * Turns run one at a time inside a chat and concurrently across chats. A
 * person's newer message interrupts an in-progress person turn and takes its
 * place; an agent's message queues behind the active turn without dropping it.
 */
export const runBridgeEventLoop = async <TLive extends BridgeLiveTurn>(
  options: BridgeEventLoopOptions<TLive>,
): Promise<void> => {
  const answered = new Set<string>();
  const lanes = new Map<string, BridgeChatLane<TLive>>();

  await options.client.websocket.run({
    signal: options.signal,
    onEvent: async (event) => {
      // A tap on an approval card answers a prompt; it is not a message to answer.
      if (await options.approvals.take(event)) return;
      const turn = bridgeTurn(event);
      if (!turn || answered.has(turn.eventId) || (options.ignoreWhenAborted && options.signal.aborted)) return;
      answered.add(turn.eventId);
      options.say(formatBridgeArrival(turn));
      const lane = lanes.get(turn.chatId) ?? { chain: Promise.resolve() };
      lanes.set(turn.chatId, lane);
      const live = lane.live;
      const replacing = live !== undefined && replacesLiveTurn(turn, { fromAgent: lane.liveFromAgent === true });
      if (live !== undefined && replacing) {
        live.dropped = true;
        await options.interrupt(live);
      }
      let ready!: () => void;
      const handed = new Promise<void>((resolve) => { ready = resolve; });
      // Nothing may be thrown here: a failure would close the connection, and
      // an agent failing to answer one message is not a reason to stop.
      lane.chain = lane.chain.then(() => options.answer(turn, lane, ready))
        .catch(() => undefined).finally(() => { ready(); });
      // A message that waits behind the live turn is taken now, so the turn
      // it waits for does not hold this connection for every other chat.
      if (live !== undefined && !replacing) ready();
      // Relay is told the message is handled once the agent is working on it.
      // The rest of the turn does not hold this connection, because every other
      // chat's messages, and the next message in this one, arrive down it.
      await handed;
    },
    onFullSync: async () => {
      // This process keeps no copy of any chat, so there is nothing to rebuild.
      // Throwing here would not stop the bridge: the SDK closes the socket and
      // reconnects, Relay re-issues the same FULL sync, and no message is ever
      // answered again. Acknowledge it and answer the new ones.
      options.say(`${options.label} was away longer than Relay keeps its messages. It answers the new ones from now on.`);
    },
  });
};
