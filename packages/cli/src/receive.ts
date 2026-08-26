/**
 * Receive loop: long-poll GET /v1/events → durable queue → engine turn →
 * one finalized message per turn.
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
 *  - Polling is a plain pull: no exclusive consumer, no cursor faults to
 *    recover from, and it coexists with a webhook on the same agent. A cursor
 *    that falls behind simply reads more events.
 */
import { createHash } from "node:crypto";
import { relayId } from "@relaymessenger/sdk";
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

/**
 * The local ledger key for one turn's exact event batch. Purely durable-state
 * identity — what `attempted_turns` and `pending_replies` are keyed on — not
 * anything the wire sees: a send's retry key is its `msg_` id.
 */
export function turnLedgerKey(conversationId: string, eventIds: string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([conversationId, eventIds]))
    .digest("hex");
  return `relay-turn-${digest.slice(0, 40)}`;
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
    for (const conversationId of touched) {
      this.scheduleFlush(conversationId);
      this.ackQueuedBehindTurn(conversationId);
    }
    return accepted;
  }

  /**
   * A turn snapshots its batch at start, so a message that lands while the
   * turn runs would sit at "Delivered" until its own turn — after the reply,
   * plus another debounce. Mark the queue head read now instead.
   * Best-effort: the next turn's own read receipt covers the same watermark,
   * so a failure here only delays it.
   */
  private ackQueuedBehindTurn(conversationId: string): void {
    if (!this.turnChains.has(conversationId)) return;
    const queue = this.state.current.pending_events[conversationId] ?? [];
    const newest = queue[queue.length - 1]?.data?.message;
    if (!newest) return;
    void this.client
      .markRead(conversationId, newest.id)
      .catch((error) => this.log(`mid-turn read receipt failed for ${conversationId}: ${error}`));
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
    // First owner message pins the default notify/MCP conversation, and with
    // it the only conversation an approval card may be shown in.
    this.state.current.owner_conversation_id ??= message.conversation_id;
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

  /**
   * A one-shot explanation to the owner. Never retried — the batch it
   * describes is already cleared — so its id is minted inline rather than
   * persisted.
   */
  private async postNotice(conversationId: string, text: string): Promise<void> {
    try {
      await this.client.postMessage({
        conversation_id: conversationId,
        parts: [{ type: "text", text }],
      });
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

  /**
   * Deliver an engine-completed reply without rerunning tools. Every attempt
   * reuses the reply's persisted `msg_` id, so a retry after a lost response
   * is a replay rather than a second message.
   */
  private async deliverPendingReply(
    turnKey: string,
    reply: NonNullable<BridgeState["pending_replies"]>[string],
  ): Promise<boolean> {
    if (!reply.message_id) {
      // A queue written before ids were the retry key. Adopt one and make it
      // durable BEFORE the first attempt, or the retry would send twice.
      reply.message_id = relayId("msg");
      (this.state.current.pending_replies ??= {})[turnKey] = reply;
      this.state.persist();
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.postMessage({
          conversation_id: reply.conversation_id,
          message_id: reply.message_id,
          parts: [{ type: "text", text: reply.text }],
        });
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

    // Recover the exact prefix a previous run durably claimed before it
    // disappeared. Later events may already be queued; they must survive and
    // run separately, while the attempted prefix is never re-executed.
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
        `turn ${attempted.turn_key} was interrupted; dropping its ${prefix.length}-event prefix, not re-executing`,
      );
      this.clearBatch(conversationId, prefix, attempted.turn_key);
      await this.postNotice(
        conversationId,
        "The bridge restarted while working on your last message, so it was not retried " +
          "automatically (its tools may have partially run). Send it again to retry.",
      );
      return;
    }

    // Snapshot: routeEvent keeps appending to the live queue while the turn
    // runs, and the post-turn filter must only remove what THIS turn consumed.
    const events = [...(this.state.current.pending_events[conversationId] ?? [])];
    if (events.length === 0) return;
    const messages = events
      .map((event) => event.data?.message)
      .filter((message): message is RelayMessage => message !== undefined);
    const promptText = promptTextFromMessages(messages);
    if (promptText.length === 0) {
      // Nothing promptable; drop only THIS batch durably — later events must
      // survive for their own turns — and still mark it read, or a
      // media-only message with no fallback text pins at Delivered forever.
      this.clearBatch(conversationId, events);
      const newestUnpromptable = messages[messages.length - 1];
      if (newestUnpromptable) {
        try {
          await this.client.markRead(conversationId, newestUnpromptable.id);
        } catch (error) {
          this.log(`read receipt for unpromptable batch failed for ${conversationId}: ${error}`);
        }
      }
      return;
    }

    const lastMessage = messages[messages.length - 1]!;
    // Advance the read watermark over the complete debounced batch before the
    // engine runs. A rejected receipt propagates visibly and leaves the batch
    // unattempted, so no tool turn can run behind a stale Delivered stamp.
    await this.client.markRead(conversationId, lastMessage.id);

    const typing = this.startTyping(conversationId);
    try {
      // Crash semantics: engine/tool side effects are at-most-once per batch.
      // The exact event-id batch is persisted AFTER replay-safe lifecycle
      // preflight and BEFORE the engine starts. A later message cannot change
      // or overwrite which prefix was already attempted.
      const eventIds = events.map((event) => event.event_id);
      const turnKey = turnLedgerKey(conversationId, eventIds);
      (this.state.current.attempted_turns ??= {})[conversationId] = {
        turn_key: turnKey,
        event_ids: eventIds,
        started_at: new Date().toISOString(),
      };
      this.state.persist();

      let result;
      try {
        result = await this.engine.startTurn(
          { conversationId, cwd: this.cwd },
          promptText,
          {
            onToolEvent: (event) => typing.note(event.title ?? "Working…"),
            onPermissionAsk: (ask) => this.askPermission(conversationId, ask),
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
        // Minted with the text, not at delivery: this id is the reply's only
        // retry key, so it has to survive the crash that forces a retry.
        message_id: relayId("msg"),
      };
      (this.state.current.pending_replies ??= {})[turnKey] = pendingReply;
      this.state.persist();
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
   * Route an approval card. The card carries the tool's raw input, so it may
   * only be shown where the owner alone reads it: the conversation pinned by
   * their first message. An ask arriving from anywhere else — a group the
   * owner spoke in — is routed there, and denied outright when no such
   * conversation exists yet.
   */
  private async askPermission(
    conversationId: string,
    ask: PermissionAsk,
  ): Promise<PermissionDecision> {
    const owner = this.state.current.owner_conversation_id;
    if (owner === conversationId) return this.broker.ask(conversationId, ask, this.engine.engine);
    if (!owner) {
      this.log(
        `approval for ${ask.toolName ?? "a tool"} denied: no owner conversation to ask in`,
      );
      return this.broker.denyUnaskable(ask);
    }
    this.log(`approval routed to the owner's conversation ${owner}`);
    return this.broker.ask(owner, ask, this.engine.engine);
  }

  /**
   * Ephemeral typing: fire and forget, no lease and no label, so the phone
   * hides the indicator on its own if this process dies mid-turn.
   */
  private startTyping(conversationId: string) {
    let active = true;
    const push = async (reason: "start" | "tool" | "keepalive") => {
      if (!active) return;
      try {
        await this.client.setTyping(conversationId, true);
      } catch (error) {
        this.log(`typing ${reason} failed for ${conversationId}: ${error}`);
      }
    };
    void push("start");
    const interval = setInterval(() => {
      void push("keepalive");
    }, 20_000);
    interval.unref?.();
    return {
      /** A tool started. Relay carries no label, so it only reaches the log. */
      note: (title: string) => {
        this.log(`${conversationId}: ${title.slice(0, 80)}`);
        void push("tool");
      },
      stop: async () => {
        if (!active) return;
        active = false;
        clearInterval(interval);
        try {
          await this.client.setTyping(conversationId, false);
        } catch (error) {
          this.log(`typing stop failed for ${conversationId}: ${error}`);
        }
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
        if (error?.status === 401) {
          this.log("fatal: agent API key rejected (401); run `relaymessenger pair` again.");
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
