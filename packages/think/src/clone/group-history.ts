import type { Message } from "@relaymessenger/sdk";
import type { UIMessage } from "ai";

import { chatTimes, validateTimezone } from "./person-time.js";

/**
 * The Session id Think gives a Relay Message: `${messengerId}:${message.id}`,
 * matching `callHistoryMessage`. One id per Relay Message, so every append of
 * it is idempotent.
 */
export function relaySessionId(messageId: string): string {
  return `relay:${messageId}`;
}

function sentAt(message: Message): number {
  return Date.parse(message.sent_at ?? message.created_at);
}

/**
 * The Relay Message a stored row stands for: its own id, or the Message its
 * send Action posted.
 */
function rowRelayIds(row: UIMessage): string[] {
  const ids = row.id.startsWith("relay:") ? [row.id.slice("relay:".length)] : [];
  for (const part of row.parts) {
    const output = (part as { output?: unknown }).output;
    const messageId = typeof output === "object" && output !== null
      ? (output as { messageId?: unknown }).messageId
      : undefined;
    if (part.type.startsWith("tool-") && typeof messageId === "string") ids.push(messageId);
  }
  return ids;
}

/**
 * The Session path with the group Messages it lacks put back where they
 * were said, oldest first. A stored row is dated by the Relay Message it
 * holds or sent; a row with no Relay Message (a call note, a member joining)
 * keeps its place after the row before it. Stored rows never move relative
 * to each other.
 */
export function mergeGroupHistory(
  stored: readonly UIMessage[],
  missing: ReadonlyArray<{ message: Message; row: UIMessage }>,
  relayMessages: ReadonlyMap<string, Message>,
): UIMessage[] {
  let previous = -Infinity;
  const dated = stored.map((row) => {
    const times = rowRelayIds(row).flatMap((id) => {
      const message = relayMessages.get(id);
      return message ? [sentAt(message)] : [];
    });
    if (times.length) previous = Math.min(...times);
    return previous;
  });
  const merged: UIMessage[] = [];
  let index = 0;
  for (const { message, row } of [...missing].sort((a, b) => sentAt(a.message) - sentAt(b.message))) {
    const at = sentAt(message);
    while (index < stored.length && dated[index]! <= at) merged.push(stored[index++]!);
    merged.push(row);
  }
  merged.push(...stored.slice(index));
  return merged;
}

/** A person's IANA timezone as Relay reports it on their handle, if valid. */
export function validTimezone(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return validateTimezone(value);
  } catch {
    return undefined;
  }
}

/**
 * The time header a group Message carries in the model's history, the way a
 * chat app shows it: on the first Message, and on one an hour or more after
 * the Message before it, in the sender's timezone or, for an agent, the newest
 * person's.
 */
export function groupTimeHeader(
  previousAt: number | undefined,
  at: number,
  timezone: string | undefined,
): string | undefined {
  if (!timezone || Number.isNaN(at)) return undefined;
  const dates = previousAt === undefined ? [new Date(at)] : [new Date(previousAt), new Date(at)];
  return chatTimes(dates, timezone).at(-1);
}
