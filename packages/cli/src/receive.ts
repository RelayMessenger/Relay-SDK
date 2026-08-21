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
 *  - Cursor faults: Relay rejects a cursor it never delivered (422) and one
 *    that fell behind the seven-day event retention (410 cursor_expired).
 *    Neither is retryable on the same cursor, so both reconcile from
 *    conversation history first and then resume or stop, never re-poll blind.
 */
import { createHash } from "node:crypto";
import { RelayApiError, type RelayClient } from "./api.js";
import type { BridgeState, RelayEvent, RelayMessage, StateStore } from "./store.js";
import type { EngineAdapter, PermissionAsk, PermissionDecision } from "./engine/types.js";
import { engineDisplayName } from "./engine/catalog.js";
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

/** Conversations read (and named in the recovery log line) after a cursor fault. */
const CURSOR_RECOVERY_CONVERSATIONS = 25;

/** What the supervisor does with a cursor fault after the recovery ran. */
type CursorFaultOutcome = "resumed" | "terminal" | "unhandled";

/**
 * Relay's undelivered-cursor fault names its own recovery target in
 * `error.details`: `highest_delivered_cursor` for a cursor the ledger never
 * handed out, `latest_sequence` for one past the agent's newest event. A
 * recovery only ever lowers the cursor. Raising it would acknowledge, and let
 * the retention sweep delete, events this bridge has never read.
 */
export function undeliveredCursorTarget(
  error: { status?: number; details?: Record<string, unknown> },
  cursor: number,
): number | undefined {
  if (error.status !== 422) return undefined;
  for (const key of ["highest_delivered_cursor", "latest_sequence"]) {
    const value = error.details?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < cursor) {
      return value;
    }
  }
  return undefined;
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
   * turn runs cannot advance that turn's /responding watermark and would sit
   * at "Delivered" until its own turn — after the reply, plus another
   * debounce. Mark the queue head read now instead. /read is the receipt
   * without /responding's typing side effect, so the running turn's tool
   * label survives. Best-effort: the next turn's /responding still covers
   * the same watermark durably, so a failure here only delays the receipt.
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

  /**
   * Read the canonical record after a cursor fault. Conversation history is
   * Relay's documented recovery path: the event log can no longer say what
   * moved, so the bridge names the head of every conversation it can still
   * see. Nothing is replayed into the engine and nothing is invented for the
   * events Relay deleted.
   */
  private async reconcileHistory(): Promise<string> {
    const conversationIds = new Set<string>(Object.keys(this.state.current.pending_events));
    const owner = this.state.current.owner_conversation_id;
    if (owner) conversationIds.add(owner);
    try {
      const listed = await this.client.listConversations(CURSOR_RECOVERY_CONVERSATIONS);
      for (const conversation of listed.conversations ?? []) {
        if (conversation?.id) conversationIds.add(conversation.id);
      }
    } catch (error) {
      this.log(`conversation listing failed during cursor recovery: ${error}`);
    }
    const heads: string[] = [];
    const readable = [...conversationIds].slice(0, CURSOR_RECOVERY_CONVERSATIONS);
    for (const conversationId of readable) {
      try {
        const { messages } = await this.client.listMessages(conversationId, 1);
        const newest = messages?.[0];
        heads.push(
          newest
            ? `${conversationId} head ${newest.id} seq ${newest.sequence}` +
              `${newest.created_at ? ` at ${newest.created_at}` : ""}`
            : `${conversationId} empty`,
        );
      } catch (error) {
        heads.push(`${conversationId} unreadable (${error instanceof Error ? error.message : error})`);
      }
    }
    if (conversationIds.size > readable.length) {
      heads.push(`${conversationIds.size - readable.length} further conversations not read`);
    }
    return heads.length > 0 ? heads.join("; ") : "no conversations were visible to reconcile";
  }

  /**
   * Apply Relay's cursor-fault contract. Both faults are permanent for the
   * cursor that produced them, so neither may fall through to the generic
   * retry: an undelivered cursor resumes from the ledger position Relay
   * reports. For an expired cursor, the bridge first reads canonical history,
   * then explicitly confirms that reconciliation so Relay can advance only
   * across the proven retention gap.
   */
  private async recoverFromCursorFault(error: RelayApiError): Promise<CursorFaultOutcome> {
    const cursor = this.state.current.cursor;
    const target = undeliveredCursorTarget(error, cursor);
    if (target !== undefined) {
      const history = await this.reconcileHistory();
      this.state.current.cursor = target;
      this.state.persist();
      this.log(
        `poll cursor ${cursor} was never delivered by Relay (422 ${error.code ?? "invalid_request"}); ` +
          `reconciled conversation history and resumed from Relay's highest delivered cursor ${target}. ` +
          `Events after ${target} are redelivered and deduplicated by event_id, so nothing is skipped. ` +
          `History head: ${history}`,
      );
      return "resumed";
    }
    if (error.status === 410 && error.code === "cursor_expired") {
      const history = await this.reconcileHistory();
      const highestDelivered = error.details?.highest_delivered_cursor;
      const advertisedResume = error.details?.resume_cursor;
      const reconciliationRequired = error.details?.reconciliation_required;
      if (
        reconciliationRequired === true
        && typeof highestDelivered === "number"
        && Number.isSafeInteger(highestDelivered)
        && highestDelivered >= 0
        && highestDelivered <= cursor
      ) {
        const reconciled = await this.client.reconcileEvents(highestDelivered);
        if (
          reconciled.reconciled !== true
          || !Number.isSafeInteger(reconciled.resume_cursor)
          || reconciled.resume_cursor < 0
          || (
            typeof advertisedResume === "number"
            && reconciled.resume_cursor !== advertisedResume
          )
        ) {
          throw new Error(
            `Relay returned an invalid cursor reconciliation response for expired cursor ${cursor}`,
          );
        }
        this.state.current.cursor = reconciled.resume_cursor;
        this.state.persist();
        this.log(
          `Relay expired poll cursor ${cursor} (410 cursor_expired); reconciled canonical conversation ` +
            `history, confirmed the retention gap, and resumed from ${reconciled.resume_cursor}. ` +
            `Deleted events cannot be replayed, but polling is live again. History head: ${history}`,
        );
        return "resumed";
      }
      this.log(
        `fatal: Relay expired this bridge's poll cursor ${cursor} (410 cursor_expired). Relay keeps the event ` +
          `log for seven days, so events recorded after that cursor were deleted before this bridge read them. ` +
          `They cannot be replayed, and any message they carried stays unanswered and is unrecoverable from the ` +
          `event log; conversation history below is the only record of it. History head: ${history}. Polling ` +
          `stops because this server did not advertise the explicit reconciliation contract.`,
      );
      return "terminal";
    }
    return "unhandled";
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
        `turn ${attempted.turn_key} was interrupted; dropping its ${prefix.length}-event prefix, not re-executing`,
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
    const respondingLabel = engineDisplayName(this.engine.engine);
    // Mark the complete debounced watermark before engine execution. A
    // rejected /responding call propagates visibly and leaves the batch
    // unattempted, so no tool turn can run behind a stale Delivered receipt.
    await this.client.setResponding(
      conversationId,
      lastMessage.id,
      respondingLabel,
      invocationId,
    );

    const typing = this.startTyping(
      conversationId,
      invocationId,
      respondingLabel,
    );
    try {
      // Crash semantics: engine/tool side effects are at-most-once per batch.
      // The exact event-id batch is persisted AFTER replay-safe lifecycle
      // preflight and BEFORE the engine starts. A later message cannot change
      // or overwrite which prefix was already attempted.
      const eventIds = events.map((event) => event.event_id);
      const turnKey = turnIdempotencyKey(conversationId, eventIds);
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

  private startTyping(
    conversationId: string,
    invocationId: string | undefined,
    initialLabel: string,
  ) {
    let label: string | undefined = initialLabel;
    let active = true;
    const push = async (reason: "start" | "label" | "keepalive") => {
      if (!active) return;
      try {
        await this.client.setTyping(
          conversationId,
          true,
          label,
          invocationId,
        );
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
      setLabel: (next: string) => {
        label = next.slice(0, 80);
        void push("label");
      },
      stop: async () => {
        if (!active) return;
        active = false;
        clearInterval(interval);
        try {
          await this.client.setTyping(
            conversationId,
            false,
            undefined,
            invocationId,
          );
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
        if (error instanceof RelayApiError && (error.status === 410 || error.status === 422)) {
          const outcome = await this.recoverFromCursorFault(error);
          if (outcome === "resumed") {
            failures = 0;
            continue;
          }
          if (outcome === "terminal") throw error;
        }
        if (error?.status === 409) {
          // Another consumer (webhook or second long-poll) owns this token.
          this.log(`fatal: ${error.message}`);
          throw error;
        }
        if (error?.status === 401) {
          this.log("fatal: agent token rejected (401); run `relaymessenger pair` again.");
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
