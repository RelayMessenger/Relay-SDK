/**
 * Receive loop: long-poll GET /v1/events → durable queue → engine turn →
 * one finalized POST /v1/messages per turn.
 *
 * Reliability contract:
 *  - Durable-before-ack: inbound events are appended to state.json's
 *    pending_events queue in the SAME atomic write that advances the cursor,
 *    so an acked event is always durable and a crash replays, never drops.
 *  - Dedupe: delivery is at-least-once; event_id is checked against a
 *    persisted seen-set before enqueueing.
 *  - Debounce: rapid messages in one conversation coalesce for ~800 ms into a
 *    single engine turn.
 *  - Supervisor: poll/turn failures restart with exponential backoff + jitter.
 */
import { createHash } from "node:crypto";
import type { RelayClient } from "./api.js";
import type { BridgeState, RelayEvent, RelayMessage, StateStore } from "./store.js";
import type { EngineAdapter, PermissionAsk, PermissionDecision } from "./engine/types.js";
import { PermissionBroker } from "./permissions.js";

export interface ReceiveLoopOptions {
  /** Pinned Relay user id allowed to drive this bridge (required). */
  ownerUserId: string;
  debounceMs?: number;
  cwd?: string;
  log?: (line: string) => void;
  /** Injected for tests. */
  setTimeoutImpl?: typeof setTimeout;
}

export function turnIdempotencyKey(conversationId: string, eventIds: string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([conversationId, eventIds]))
    .digest("hex");
  return `relay-turn-${digest.slice(0, 40)}`;
}

/**
 * Group events carry `data.invocation_id`; direct events do not. Its presence
 * is how the bridge tells the two apart, and the id is required on every
 * outbound call for that turn.
 */
export function invocationIdForEvent(event: RelayEvent | undefined): string | undefined {
  const value = event?.data?.invocation_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The batch a single turn may consume. Direct conversations coalesce a burst
 * into one turn as before. A group invocation is single-use server-side (one
 * message completes it), so a group turn is capped at the oldest invocation
 * and later invocations stay queued for their own turns and their own replies.
 */
export function batchForTurn(queue: RelayEvent[]): RelayEvent[] {
  const invocationId = invocationIdForEvent(queue[0]);
  if (!invocationId) return [...queue];
  return queue.filter((event) => invocationIdForEvent(event) === invocationId);
}

export function promptTextFromMessages(messages: RelayMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    const text = message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    chunks.push(text.length > 0 ? text : message.fallback_text);
  }
  return chunks.filter((chunk) => chunk && chunk.length > 0).join("\n\n");
}

export class ReceiveLoop {
  private readonly ownerUserId: string;
  private readonly debounceMs: number;
  private readonly cwd: string;
  private readonly log: (line: string) => void;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  /** Serializes turns per conversation. */
  private readonly turnChains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly client: RelayClient,
    private readonly state: StateStore,
    private readonly engine: EngineAdapter,
    readonly broker: PermissionBroker,
    options: ReceiveLoopOptions,
  ) {
    this.ownerUserId = options.ownerUserId;
    this.debounceMs = options.debounceMs ?? 800;
    this.cwd = options.cwd ?? process.cwd();
    this.log = options.log ?? (() => {});
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  }

  /**
   * One poll cycle: fetch, dedupe, durably enqueue + ack, schedule flushes.
   * Exposed for tests; `run()` supervises it forever.
   */
  async pollOnce(timeoutS = 25): Promise<number> {
    const page = await this.client.getEvents(this.state.current.cursor, timeoutS);
    const touched = new Set<string>();
    let accepted = 0;
    for (const event of page.events ?? []) {
      if (!event.event_id || this.state.hasSeen(event.event_id)) continue;
      this.state.markSeen(event.event_id);
      const routed = this.routeEvent(event);
      if (routed) {
        touched.add(routed);
        accepted += 1;
      }
    }
    // Durable-before-ack: queue mutation and cursor advance are one atomic write.
    if (typeof page.next_cursor === "number") {
      this.state.current.cursor = page.next_cursor;
    }
    this.state.persist();
    for (const conversationId of touched) this.scheduleFlush(conversationId);
    return accepted;
  }

  /** Returns the conversation id when the event was enqueued for the engine. */
  private routeEvent(event: RelayEvent): string | undefined {
    if (event.event_type !== "message.received") return undefined;
    const message = event.data?.message;
    if (!message || message.sender?.kind !== "user") return undefined;
    // Owner gate before any content is interpreted: non-owner senders can
    // neither prompt the engine nor answer a permission card.
    if (message.sender.id !== this.ownerUserId) {
      this.log(`ignoring message from non-owner sender ${message.sender.id}`);
      return undefined;
    }
    // First owner message pins the default notify/MCP conversation. A group
    // is never that conversation: sends there need an invocation this agent
    // does not have, and approvals must reach the owner alone.
    if (!invocationIdForEvent(event)) {
      this.state.current.owner_conversation_id ??= message.conversation_id;
    }
    if (this.broker.consumeReply(message)) return undefined;
    const queue = (this.state.current.pending_events[message.conversation_id] ??= []);
    queue.push(event);
    return message.conversation_id;
  }

  private scheduleFlush(conversationId: string): void {
    if (this.stopped) return;
    const existing = this.debounceTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = this.setTimeoutImpl(() => {
      this.debounceTimers.delete(conversationId);
      this.chainTurn(conversationId);
    }, this.debounceMs);
    (timer as NodeJS.Timeout).unref?.();
    this.debounceTimers.set(conversationId, timer as NodeJS.Timeout);
  }

  private chainTurn(conversationId: string): void {
    const previous = this.turnChains.get(conversationId) ?? Promise.resolve();
    const next = previous
      .then(() => this.runTurn(conversationId))
      .catch((error) => {
        this.log(`turn failed for ${conversationId}: ${error}`);
      });
    this.turnChains.set(conversationId, next);
    void next.finally(() => {
      if (this.turnChains.get(conversationId) === next) this.turnChains.delete(conversationId);
    });
  }

  /** Waits for in-flight turns (tests + graceful shutdown). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.turnChains.values()]);
  }

  /** Removes THIS turn's consumed events (and its attempt marker) durably. */
  private clearBatch(conversationId: string, events: RelayEvent[], turnKey?: string): void {
    const queue = this.state.current.pending_events[conversationId] ?? [];
    const remaining = queue.filter(
      (event) => !events.some((consumed) => consumed.event_id === event.event_id),
    );
    if (remaining.length === 0) {
      delete this.state.current.pending_events[conversationId];
    } else {
      this.state.current.pending_events[conversationId] = remaining;
      // New messages arrived mid-turn; run again.
      this.scheduleFlush(conversationId);
    }
    const attempted = (this.state.current.attempted_turns ??= {})[conversationId];
    if (attempted && (!turnKey || attempted.turn_key === turnKey)) {
      delete this.state.current.attempted_turns![conversationId];
    }
    if (turnKey) delete (this.state.current.pending_replies ??= {})[turnKey];
    this.state.persist();
  }

  private async postNotice(
    conversationId: string,
    text: string,
    key: string,
    invocationId?: string,
  ): Promise<void> {
    try {
      await this.client.postMessage(
        {
          conversation_id: conversationId,
          parts: [{ type: "text", text }],
          ...(invocationId ? { invocation_id: invocationId } : {}),
        },
        key,
      );
    } catch (error) {
      this.log(`notice post failed for ${conversationId}: ${error}`);
    }
  }

  private pendingReplyForConversation(conversationId: string):
    | [string, NonNullable<BridgeState["pending_replies"]>[string]]
    | undefined {
    return Object.entries(this.state.current.pending_replies ?? {}).find(
      ([, reply]) => reply.conversation_id === conversationId,
    );
  }

  /** Idempotently deliver an engine-completed reply without rerunning tools. */
  private async deliverPendingReply(
    turnKey: string,
    reply: NonNullable<BridgeState["pending_replies"]>[string],
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.postMessage(
          {
            conversation_id: reply.conversation_id,
            parts: [{ type: "text", text: reply.text }],
            ...(reply.invocation_id ? { invocation_id: reply.invocation_id } : {}),
          },
          turnKey,
        );
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => this.setTimeoutImpl(resolve, 1_000 * (attempt + 1)));
        }
      }
    }
    this.log(`final reply post failed for ${reply.conversation_id}: ${lastError}`);
    return false;
  }

  async runTurn(conversationId: string): Promise<void> {
    // Delivery is its own durable phase. Finish an older reply before looking
    // at newer queued prompts, otherwise appending a message after an unknown
    // POST outcome could cause the older tool turn to execute again.
    const queuedReply = this.pendingReplyForConversation(conversationId);
    if (queuedReply) {
      const [turnKey, reply] = queuedReply;
      const queuedEvents = this.state.current.pending_events[conversationId] ?? [];
      const consumed = queuedEvents.filter((event) => reply.event_ids.includes(event.event_id));
      if (await this.deliverPendingReply(turnKey, reply)) {
        this.clearBatch(conversationId, consumed, turnKey);
      } else {
        this.scheduleFlush(conversationId);
      }
      return;
    }

    // Recover the exact prefix a previous invocation durably claimed before
    // it disappeared. Later events may already be queued; they must survive
    // and run separately, while the attempted prefix is never re-executed.
    const attempted = (this.state.current.attempted_turns ??= {})[conversationId];
    if (attempted) {
      const queue = this.state.current.pending_events[conversationId] ?? [];
      const prefix = queue.slice(0, attempted.event_ids.length);
      if (
        prefix.length !== attempted.event_ids.length ||
        prefix.some((event, index) => event.event_id !== attempted.event_ids[index])
      ) {
        throw new Error(
          `attempt ledger mismatch for ${conversationId}; refusing to execute queued events`,
        );
      }
      this.log(
        `turn ${attempted.turn_key} was interrupted — dropping its ${prefix.length}-event prefix, not re-executing`,
      );
      const interruptedInvocation = invocationIdForEvent(prefix[prefix.length - 1]);
      this.clearBatch(conversationId, prefix, attempted.turn_key);
      await this.postNotice(
        conversationId,
        "The bridge restarted while working on your last message, so it was not retried " +
          "automatically (its tools may have partially run). Send it again to retry.",
        `${attempted.turn_key}-crashed`,
        interruptedInvocation,
      );
      return;
    }

    // Snapshot: routeEvent keeps appending to the live queue while the turn
    // runs, and the post-turn filter must only remove what THIS turn consumed.
    const events = batchForTurn(this.state.current.pending_events[conversationId] ?? []);
    if (events.length === 0) return;
    const invocationId = invocationIdForEvent(events[events.length - 1]);
    const messages = events
      .map((event) => event.data?.message)
      .filter((message): message is RelayMessage => message !== undefined);
    const promptText = promptTextFromMessages(messages);
    if (promptText.length === 0) {
      // Nothing promptable; drop the batch durably.
      delete this.state.current.pending_events[conversationId];
      this.state.persist();
      return;
    }

    // Crash semantics: engine/tool side effects are at-most-once per batch.
    // The exact event-id batch is persisted BEFORE the engine starts. A later
    // message cannot change or overwrite which prefix was already attempted.
    const eventIds = events.map((event) => event.event_id);
    const turnKey = turnIdempotencyKey(conversationId, eventIds);
    (this.state.current.attempted_turns ??= {})[conversationId] = {
      turn_key: turnKey,
      event_ids: eventIds,
      started_at: new Date().toISOString(),
    };
    this.state.persist();

    const typing = this.startTyping(conversationId, invocationId);
    try {
      let result;
      try {
        result = await this.engine.startTurn(
          { conversationId, cwd: this.cwd },
          promptText,
          {
            onToolEvent: (event) => typing.setLabel(event.title ?? "Working…"),
            onPermissionAsk: (ask) => this.askPermission(conversationId, invocationId, ask),
          },
        );
      } catch (error) {
        // A failed engine turn is not silently retried (its side effects may
        // have partially run) and must not strand the queue: tell the owner
        // and clear the batch so the conversation stays usable.
        this.log(`engine turn failed for ${conversationId}: ${error}`);
        this.clearBatch(conversationId, events, turnKey);
        await this.postNotice(
          conversationId,
          `The ${this.engine.engine} turn failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}\n` +
            "Send your message again to retry.",
          `${turnKey}-failed`,
          invocationId,
        );
        return;
      }
      const text = result.text.trim().length > 0
        ? result.text.trim()
        : `(turn finished: ${result.stopReason})`;
      // Persist the completed output BEFORE delivery. Any crash from here on
      // can retry this idempotent POST without rerunning the engine or tools.
      const pendingReply = {
        conversation_id: conversationId,
        event_ids: events.map((event) => event.event_id),
        text,
        created_at: new Date().toISOString(),
        ...(invocationId ? { invocation_id: invocationId } : {}),
      };
      (this.state.current.pending_replies ??= {})[turnKey] = pendingReply;
      this.state.persist();
      // Clearing typing needs the invocation still pending, and the reply is
      // what completes it, so stop before delivering rather than in `finally`.
      if (invocationId) await typing.stop();
      if (await this.deliverPendingReply(turnKey, pendingReply)) {
        this.clearBatch(conversationId, events, turnKey);
      } else {
        // Keep the queue, attempt marker and completed reply. The scheduled
        // retry enters the delivery-only path above.
        this.scheduleFlush(conversationId);
      }
    } finally {
      await typing.stop();
    }
  }

  /**
   * Route an approval card. A group invocation is spent by the single reply it
   * owes, so a card posted into the group would consume it and leave the turn
   * unable to answer. Group approvals therefore go to the owner's direct
   * conversation with this agent, and deny when there is no such conversation
   * to ask in.
   */
  private async askPermission(
    conversationId: string,
    invocationId: string | undefined,
    ask: PermissionAsk,
  ): Promise<PermissionDecision> {
    if (!invocationId) return this.broker.ask(conversationId, ask, this.engine.engine);
    const direct = this.state.current.owner_conversation_id;
    if (!direct || direct === conversationId) {
      this.log(
        `group approval for ${ask.toolName ?? "a tool"} denied: no direct conversation with the owner to ask in`,
      );
      return this.broker.denyUnaskable(ask);
    }
    this.log(`group approval routed to the owner's direct conversation ${direct}`);
    return this.broker.ask(direct, ask, this.engine.engine);
  }

  private startTyping(conversationId: string, invocationId?: string) {
    let label: string | undefined;
    let active = true;
    const push = () => {
      if (!active) return;
      this.client.setTyping(conversationId, true, label, invocationId).catch(() => {});
    };
    push();
    const interval = setInterval(push, 20_000);
    interval.unref?.();
    return {
      setLabel: (next: string) => {
        label = next.slice(0, 80);
        push();
      },
      stop: async () => {
        if (!active) return;
        active = false;
        clearInterval(interval);
        await this.client.setTyping(conversationId, false, undefined, invocationId).catch(() => {});
      },
    };
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /** Supervisor: restart the poll loop on failure with capped backoff + jitter. */
  async run(): Promise<void> {
    let failures = 0;
    // Replay anything a previous process left behind.
    this.broker.sweep();
    for (const conversationId of Object.keys(this.state.current.pending_events)) {
      this.scheduleFlush(conversationId);
    }
    while (!this.stopped) {
      try {
        this.broker.sweep();
        await this.pollOnce();
        failures = 0;
      } catch (error: any) {
        if (error?.status === 409) {
          // Another consumer (webhook or second long-poll) owns this token.
          this.log(`fatal: ${error.message}`);
          throw error;
        }
        if (error?.status === 401) {
          this.log("fatal: agent token rejected (401) — run `relaymessenger pair` again.");
          throw error;
        }
        failures += 1;
        const base = Math.min(500 * 2 ** Math.min(failures, 6), 30_000);
        const jitter = base * (0.7 + Math.random() * 0.6);
        this.log(`poll failed (attempt ${failures}), retrying in ${Math.round(jitter)}ms: ${error}`);
        await new Promise((resolve) => this.setTimeoutImpl(resolve, jitter));
      }
    }
  }
}
