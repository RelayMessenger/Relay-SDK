import type { LanguageModelMiddleware, UIMessage } from "ai";

/**
 * What @relay stores for each Message of its own conversation (owner's rule,
 * 2026-09-27): what each side said and what @relay did, never the messaging
 * platform's delivery data.
 *
 * Staging, 2026-09-27: one Chat stored 943,472 bytes for 401 Messages. Two
 * things filled it, and neither is read by the model:
 *
 * 1. Think's Chat SDK messenger stamps every person's Message with
 *    `metadata.messenger` (think chat-sdk `toMessengerUserMessage` →
 *    `messengerContextFromEvent`), which holds the adapter's `raw` webhook
 *    body (sender and owner handles, avatars, delivery times, A2UI client
 *    capabilities) and each attachment's sealed download URL.
 * 2. @ai-sdk/google writes every Gemini thought signature twice, under
 *    `googleVertex` and under `vertex` (`wrapProviderMetadata` over
 *    `providerOptionsNames = ["googleVertex", "vertex"]`).
 *
 * The model reads neither: `convertToModelMessages` ignores Message metadata,
 * and the Vertex request builder reads a part's provider options from the
 * first of `googleVertex`, `vertex` that is present
 * (@ai-sdk/google internal `readProviderOpts`), so with `googleVertex` kept
 * the `vertex` copy is never read.
 */

/**
 * The facts about a person's Message that @relay keeps, in Relay's own v1
 * Message field names: its id (what a reply or reaction targets), when it
 * was sent, who sent it, what it replied to or threaded under, and the
 * attachments it carried. Stored through Think's own per-turn carrier,
 * `ChatOptions.metadata` → `metadata.turnMetadata`, which Think documents for
 * messenger entry points and restores on a recovered turn.
 *
 * Everything else in the webhook is the messaging platform's delivery data
 * and is not kept: the Chat's owner Handle, avatars, delivery and read
 * times, idempotency key, A2UI client capabilities, and each attachment's
 * sealed URL (it expires; src/index.ts fetches the bytes once per turn from
 * the live event, never from history). The text is not repeated here: it is
 * the Message's own parts.
 */
export function relayTurnMetadata(
  messenger: unknown,
): Record<string, unknown> | undefined {
  const context = record(messenger);
  const message = record(context?.message);
  if (!message) return undefined;
  const webhook = record(record(message.raw)?.message) ?? {};
  const sender = record(webhook.sender_handle);
  const author = record(message.author) ?? {};
  const sentAt = webhook.sent_at ?? message.createdAt;
  const attachments = (Array.isArray(webhook.parts) ? webhook.parts : [])
    .map(record)
    .filter((part) => part?.type === "media")
    .map((part) => pick(part!, ["id", "filename", "mime_type", "size_bytes"]));
  return {
    message: {
      id: message.id,
      ...(sentAt === undefined
        ? {}
        : { sent_at: sentAt instanceof Date ? sentAt.toISOString() : sentAt }),
      sender_handle: sender
        ? pick(sender, ["id", "handle", "display_name", "kind"])
        : pick({
          id: author.userId,
          handle: author.userName,
          display_name: author.fullName,
        }, ["id", "handle", "display_name"]),
      ...(record(webhook.reply_to)
        ? { reply_to: pick(record(webhook.reply_to)!, ["message_id", "part_index"]) }
        : {}),
      ...(record(webhook.thread)
        ? {
          thread: pick(record(webhook.thread)!, [
            "originator_message_id",
            "originator_part_index",
          ]),
        }
        : {}),
      ...(attachments.length ? { attachments } : {}),
    },
  };
}

/**
 * A person's Message as Think's messenger hands it over, without the
 * `metadata.messenger` event Think stamps on it (think chat-sdk
 * `toMessengerUserMessage`). Nothing reads that stamp back from history but
 * Think's `getMessengerContext` fallback, whose only consumer is a
 * channel's `instructions` function, which Relay's messenger does not set.
 */
export function withoutMessengerEvent<T extends UIMessage>(message: T): T {
  const metadata = record(message.metadata);
  if (!metadata || !("messenger" in metadata)) return message;
  const { messenger: _event, ...rest } = metadata;
  return { ...message, metadata: rest } as T;
}

const GOOGLE_VERTEX = "googleVertex";
const VERTEX_ALIAS = "vertex";
const PART_PROVIDER_METADATA = ["providerMetadata", "callProviderMetadata"];

/** Provider metadata without the `vertex` copy of what `googleVertex` holds. */
export function withoutVertexAlias<T>(metadata: T): T {
  const value = record(metadata);
  if (!value || !(GOOGLE_VERTEX in value) || !(VERTEX_ALIAS in value)) {
    return metadata;
  }
  const { [VERTEX_ALIAS]: _alias, ...rest } = value;
  return rest as T;
}

/**
 * The Message as @relay stores it. Returns the same object when nothing
 * changes, so a stored history can be slimmed by rewriting only the rows
 * that differ.
 */
export function storedMessage<T extends UIMessage>(message: T): T {
  let changed = false;
  const parts = message.parts.map((part) => {
    let next = part as Record<string, unknown>;
    for (const key of PART_PROVIDER_METADATA) {
      if (!(key in next)) continue;
      const slim = withoutVertexAlias(next[key]);
      if (slim === next[key]) continue;
      next = { ...next, [key]: slim };
      changed = true;
    }
    return next as T["parts"][number];
  });
  const metadata = record(message.metadata);
  let nextMetadata: unknown = message.metadata;
  if (metadata && "messenger" in metadata) {
    // The same stored form a live turn gets: Think stamps `channel` and
    // `turnMetadata` after the Message's own metadata.
    const { messenger, channel, turnMetadata, ...rest } = metadata;
    const kept = relayTurnMetadata(messenger);
    nextMetadata = {
      ...rest,
      ...(channel === undefined ? {} : { channel }),
      ...(kept || turnMetadata
        ? { turnMetadata: { ...record(turnMetadata), ...kept } }
        : {}),
    };
    changed = true;
  }
  if (!changed) return message;
  return { ...message, parts, metadata: nextMetadata } as T;
}

/**
 * Drop the `vertex` copy from every model stream part before Think
 * accumulates and stores it. The Vertex request builder reads `googleVertex`
 * first, so the request the next turn sends is unchanged.
 */
export const storedProviderMetadata: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(
              "providerMetadata" in part && part.providerMetadata
                ? {
                  ...part,
                  providerMetadata: withoutVertexAlias(part.providerMetadata),
                }
                : part,
            );
          },
        }),
      ),
    };
  },
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.map((part) =>
        "providerMetadata" in part && part.providerMetadata
          ? {
            ...part,
            providerMetadata: withoutVertexAlias(part.providerMetadata),
          }
          : part
      ),
    };
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pick(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) picked[key] = value[key];
  }
  return picked;
}
