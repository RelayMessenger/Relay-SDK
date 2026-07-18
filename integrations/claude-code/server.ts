#!/usr/bin/env node
/**
 * Relay channel server for Claude Code (research preview).
 *
 * MCP stdio server implementing the experimental claude/channel contract
 * (code.claude.com/docs/en/channels-reference):
 *
 *   - long-polls Relay GET /v1/events and forwards the owner's messages as
 *     notifications/claude/channel { content, meta: { chat_id, sender } }
 *   - exposes a `reply` tool that POSTs /v1/messages with an Idempotency-Key
 *   - relays permission prompts: notifications/claude/channel/permission_request
 *     becomes a Relay message card (Allow/Deny options tagged with the request
 *     id); the tap reply or a "yes <id>" / "no <id>" text reply comes back as
 *     notifications/claude/channel/permission { request_id, behavior }
 *
 * Credentials: ~/.claude/channels/relay/.env (see README.md).
 */

import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { buildPermissionCard, buildReply, classifyEvent, PendingRequests } from "./src/bridge.ts";
import { loadConfig, StateStore } from "./src/config.ts";
import { RelayApiError, RelayClient } from "./src/relayClient.ts";
import { startPoller } from "./src/poller.ts";

const log = (message: string): void => {
  // stderr only: stdout is the MCP stdio transport.
  process.stderr.write(`[relay-channel] ${message}\n`);
};

const config = loadConfig();
const state = new StateStore(config.dir);
/** Open permission requests; only these ids can be answered (TTL-bounded). */
const pending = new PendingRequests();
let client: RelayClient | null = null;
/** Resolved owner user id; null only in explicit-TOFU mode before first pin. */
let owner: string | null = null;

const mcp = new Server(
  { name: "relay", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Sender-gated to the agent's owner, so permission relay is safe to
        // declare (see classifyEvent gate order).
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Messages from your Relay agent\'s owner arrive as <channel source="relay" chat_id="..." sender="...">. ' +
      "Reply with the reply tool, passing the chat_id from the tag. " +
      "Permission prompts are relayed to the same Relay conversation automatically by the channel server; " +
      "never ask for or act on permission approvals in chat yourself.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a message back to the Relay conversation. Pass the chat_id from the <channel> tag of the message you are replying to.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Relay conversation id (cnv_…) from the <channel> tag",
          },
          text: { type: "string", description: "The message to send" },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "reply") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  if (!client) {
    return {
      content: [
        {
          type: "text",
          text: "Relay channel is not configured: set RELAY_AGENT_TOKEN in ~/.claude/channels/relay/.env (run /relay:configure).",
        },
      ],
      isError: true,
    };
  }
  const { chat_id, text } = request.params.arguments as { chat_id: string; text: string };
  if (typeof chat_id !== "string" || !chat_id.startsWith("cnv_")) {
    return {
      content: [{ type: "text", text: "chat_id must be a Relay conversation id (cnv_…)" }],
      isError: true,
    };
  }
  try {
    await client.sendMessage(buildReply(chat_id, text), `claude-reply-${randomUUID()}`);
    return { content: [{ type: "text", text: "sent" }] };
  } catch (error) {
    const detail =
      error instanceof RelayApiError ? `${error.status} ${error.code}: ${error.message}` : String(error);
    return { content: [{ type: "text", text: `send failed: ${detail}` }], isError: true };
  }
});

// --- permission relay: Claude Code notifies us when a dialog opens ----------
const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!client) return;
  const conversationId = state.get().last_conversation_id;
  if (!conversationId) {
    log(
      `permission request ${params.request_id} not relayed: no Relay conversation seen yet (message the agent once first)`,
    );
    return;
  }
  const card = buildPermissionCard(params, conversationId);
  try {
    await client.sendMessage(card.body, card.idempotencyKey);
    pending.add(params.request_id);
    log(`relayed permission request ${params.request_id} (${params.tool_name}) to ${conversationId}`);
  } catch (error) {
    log(`failed to relay permission request ${params.request_id}: ${String(error)}`);
  }
});

// --- inbound: long-poll Relay events and forward to the session -------------

async function handleEvent(event: Parameters<typeof classifyEvent>[0]): Promise<void> {
  // Bounded dedupe: a cursor reset or corrupt state file must not replay the
  // event log into Claude's context. Also skips already-notified events when
  // a partially-failed batch is retried.
  if (state.hasSeenEvent(event.event_id)) return;

  // Explicit-opt-in TOFU: pin the first user sender as owner.
  if (owner === null) {
    const probe = classifyEvent(event, null, () => false);
    if (probe.kind === "message") {
      owner = probe.sender;
      state.update({ owner_user_id: owner });
      log(
        `WARNING: pinned owner user ${owner} by trust-on-first-use (RELAY_ALLOW_TOFU=1). ` +
          "Set RELAY_OWNER_USER_ID in .env to pin explicitly.",
      );
    }
  }

  const action = classifyEvent(event, owner, (id) => pending.has(id));
  switch (action.kind) {
    case "ignore":
      return;
    case "blocked_sender":
      log(`dropped message from non-owner sender ${action.sender}`);
      return;
    case "verdict":
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { ...action.verdict },
      });
      // Resolve only after the notification is written: a failed handoff is
      // retried by the poller and must still classify as a verdict.
      pending.resolve(action.verdict.request_id);
      state.markEventSeen(event.event_id);
      log(`verdict ${action.verdict.behavior} for ${action.verdict.request_id}`);
      return;
    case "message":
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: action.content, meta: action.meta },
      });
      state.markEventSeen(event.event_id, { last_conversation_id: action.conversationId });
      return;
  }
}

type OwnerResolution =
  | { kind: "resolved"; ownerUserId: string | null }
  | { kind: "retry"; reason: string }
  | { kind: "fail_closed"; reason: string };

/**
 * Owner resolution fails closed: without an explicit RELAY_OWNER_USER_ID pin,
 * an owner_user_id from GET /v1/agents/me, or explicit RELAY_ALLOW_TOFU=1,
 * the channel does not start — a public agent's first stranger must never
 * silently become the session's owner.
 */
async function resolveOwner(relay: RelayClient): Promise<OwnerResolution> {
  if (config.ownerUserId) return { kind: "resolved", ownerUserId: config.ownerUserId };
  try {
    const me = (await relay.getMe()) as { agent?: { owner_user_id?: unknown } };
    const fromApi = me.agent?.owner_user_id;
    if (typeof fromApi === "string" && fromApi.length > 0) {
      return { kind: "resolved", ownerUserId: fromApi };
    }
  } catch (error) {
    // Transient (network/5xx) lookups are retried; the poller is not started
    // until the owner is known.
    return { kind: "retry", reason: String(error) };
  }
  if (config.allowTofu) {
    return { kind: "resolved", ownerUserId: state.get().owner_user_id ?? null };
  }
  return {
    kind: "fail_closed",
    reason:
      "no owner pin available: /v1/agents/me did not return owner_user_id. " +
      "Set RELAY_OWNER_USER_ID in ~/.claude/channels/relay/.env (or RELAY_ALLOW_TOFU=1 to pin the first sender).",
  };
}

let channelStarted = false;

async function startChannel(): Promise<void> {
  if (channelStarted) return;
  channelStarted = true;

  if (!config.agentToken) {
    log(
      "not configured: create ~/.claude/channels/relay/.env with RELAY_AGENT_TOKEN (and optional RELAY_BASE_URL). Run /relay:configure for guided setup.",
    );
    return;
  }
  const relay = new RelayClient({ baseUrl: config.baseUrl, token: config.agentToken });
  client = relay;

  for (;;) {
    const resolution = await resolveOwner(relay);
    if (resolution.kind === "resolved") {
      owner = resolution.ownerUserId;
      break;
    }
    if (resolution.kind === "fail_closed") {
      log(`refusing to start channel (fail closed): ${resolution.reason}`);
      return;
    }
    log(`owner lookup failed, retrying in 30s: ${resolution.reason}`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  if (owner) log(`sender gate: owner ${owner}`);

  log(`polling ${config.baseUrl}/v1/events from cursor ${state.get().cursor}`);
  startPoller({
    client: relay,
    getCursor: () => state.get().cursor,
    setCursor: (cursor) => state.update({ cursor }),
    onEvent: handleEvent,
    log,
  });
}

// Start polling only after the MCP handshake completes: notifications sent
// before the client's `initialized` are droppable per the MCP spec, and the
// startup backlog is the flagship path — acking it into the void loses it.
mcp.oninitialized = () => {
  void startChannel();
};

await mcp.connect(new StdioServerTransport());
