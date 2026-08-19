import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the inbound event told us about the turn now in flight. `postMessage`
 * and `startTyping` never see the event, so the invocation id a group reply
 * must echo, and the event id an idempotency key must be derived from, are
 * carried here.
 *
 * The turn rides on the async execution context of the dispatch that created
 * it rather than on a map keyed by conversation. A map is wrong: the Chat SDK
 * takes its per-thread lock inside `processMessage`, well after the adapter
 * would have written the entry, so two messages arriving together in one group
 * let the second overwrite the first's entry and then get dropped by the lock,
 * leaving the first turn replying with the second's invocation and key. A
 * context store cannot be overwritten by a sibling dispatch, and it needs no
 * cleanup, so there is nothing to grow without bound either.
 *
 * The Chat SDK already runs on `AsyncLocalStorage` for its own conversation
 * context (`chat/dist/chunk-23HOOUQ5.js:130`), so this adds no runtime
 * requirement the peer dependency did not already impose.
 */
export interface RelayTurn {
  /** The conversation the inbound event arrived on. */
  readonly conversationId: string;
  readonly eventId: string;
  /** Present only for a group event: Relay scopes a group reply to it. */
  readonly invocationId?: string;
  /** Set once the invocation has been spent on a committed message. */
  invocationUsed: boolean;
  /** Messages this turn has committed. Advances only on a successful send. */
  sent: number;
}

const storage = new AsyncLocalStorage<RelayTurn>();

/** Run one inbound dispatch with its turn bound to the async context. */
export function runInTurn<T>(turn: RelayTurn, fn: () => Promise<T>): Promise<T> {
  return storage.run(turn, fn);
}

/**
 * The turn in flight, when it belongs to this conversation. A handler that
 * posts into some other conversation is not replying to the event, so it gets
 * nothing here and falls back to an unkeyed send.
 */
export function activeTurn(conversationId: string): RelayTurn | undefined {
  const turn = storage.getStore();
  return turn?.conversationId === conversationId ? turn : undefined;
}
