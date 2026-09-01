import { AsyncLocalStorage } from "node:async_hooks";

export interface RelayTurn {
  readonly eventId: string;
  sent: number;
  tail: Promise<void>;
}

/**
 * Request-local transport context. It is never persisted and owns no delivery
 * record; it only makes Relay's Idempotency-Key stable for a redelivered event.
 */
export class RelayTurnContext {
  private readonly storage = new AsyncLocalStorage<RelayTurn>();

  run<T>(eventId: string, callback: () => T): T {
    return this.storage.run(
      {
        eventId,
        sent: 0,
        tail: Promise.resolve(),
      },
      callback,
    );
  }

  active(): RelayTurn | undefined {
    return this.storage.getStore();
  }
}

export function inboundIdempotencyKey(
  eventId: string,
  ordinal: number,
): string {
  return `relay-chat-sdk:${eventId}:${ordinal}`;
}
