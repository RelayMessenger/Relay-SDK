import type { ReactionType } from "@relaymessenger/sdk";
import {
  jsonResult,
  readReactionParams,
  readStringParam,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { resolveRelayAccount } from "./accounts.js";
import { createRelaySdkClient } from "./outbound.js";
import type { RelayCoreConfig } from "./types.js";

type RelayMessageActions = NonNullable<ChannelPlugin["actions"]>;

/** Relay's six tapbacks, by the emoji a model writes for each; any other emoji is a custom reaction. */
const TAPBACKS: Record<string, Exclude<ReactionType, "custom">> = {
  "❤️": "love", "❤": "love", "love": "love",
  "👍": "like", "like": "like",
  "👎": "dislike", "dislike": "dislike",
  "😂": "laugh", "laugh": "laugh",
  "‼️": "emphasize", "‼": "emphasize", "emphasize": "emphasize",
  "❓": "question", "?": "question", "question": "question",
};

/** The Relay reaction for an emoji: a tapback, or a custom emoji of 1 to 32 characters. */
export const relayReaction = (emoji: string): { type: ReactionType; custom_emoji?: string } => {
  const value = emoji.trim();
  const tapback = TAPBACKS[value] ?? TAPBACKS[value.toLowerCase()];
  return tapback ? { type: tapback } : { type: "custom", custom_emoji: value };
};

/**
 * OpenClaw's shared `message` tool `react` action on Relay
 * (docs/plugins/sdk-channel-plugins.md, ChannelMessageActionAdapter), as
 * Telegram's channel implements it: the message is the one named, else the
 * one being answered.
 */
export const relayMessageActions: RelayMessageActions = {
  describeMessageTool: () => ({ actions: ["react"] }),
  supportsAction: ({ action }) => action === "react",
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react") throw new Error(`relay: unsupported message action ${action}`);
    const messageId = resolveReactionMessageId({
      args: params,
      ...(toolContext?.currentMessageId !== undefined ? { toolContext: { currentMessageId: toolContext.currentMessageId } } : {}),
    });
    if (messageId === undefined || !String(messageId).trim()) {
      return jsonResult({ ok: false, reason: "missing_message_id", hint: "Name the Relay message to react to." });
    }
    const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Name the emoji to remove." });
    if (isEmpty) return jsonResult({ ok: false, reason: "missing_emoji", hint: "Name the emoji to react with." });
    const account = resolveRelayAccount({ cfg: cfg as RelayCoreConfig, accountId });
    if (!account.configured) throw new Error(`relay: account "${account.accountId}" has no Relay Agent Token`);
    const partIndex = readStringParam(params, "partIndex");
    await createRelaySdkClient(account).messages.addReaction(String(messageId), {
      operation: remove ? "remove" : "add",
      ...relayReaction(emoji),
      ...(partIndex !== undefined && Number.isInteger(Number(partIndex)) ? { part_index: Number(partIndex) } : {}),
    });
    return jsonResult({ ok: true, messageId: String(messageId), emoji, removed: remove });
  },
};
