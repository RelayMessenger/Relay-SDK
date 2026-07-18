#!/usr/bin/env node
/** Relay channel MCP server for Claude Code. */

import { createHash } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { buildPermissionCard, buildReply, classifyEvent } from "./src/bridge.ts";
import {
  ConsumerLock,
  StateStore,
  loadConfig,
  type PendingApproval,
  type PendingDelivery,
  type RelayChannelConfig,
  type StateScope,
} from "./src/config.ts";
import { startPoller } from "./src/poller.ts";
import { RelayApiError, RelayClient } from "./src/relayClient.ts";
import { RetryWindow } from "./src/retryWindow.ts";
import type { PermissionRequest, RelayEvent, SendMessageBody } from "./src/types.ts";

const VERSION = "0.2.0";
const RETRY_INTERVAL_MS = 5_000;
const NOTIFICATION_RETRY_MS = 30_000;

const log = (message: string): void => {
  process.stderr.write(`[relay] ${message}\n`);
};

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

let config: RelayChannelConfig;
try {
  config = loadConfig();
} catch (error) {
  log(`invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  if (!config.agentToken) {
    log(`not configured: add RELAY_AGENT_TOKEN to ${config.dir}/.env`);
    process.exit(1);
  }
  try {
    const checkClient = new RelayClient({ baseUrl: config.baseUrl, token: config.agentToken });
    const me = (await checkClient.getMe()) as { agent?: { id?: unknown; owner_user_id?: unknown } };
    if (typeof me.agent?.id !== "string" || me.agent.id.length === 0) {
      throw new Error("GET /v1/agents/me did not return agent.id");
    }
    process.stdout.write(
      `Relay connection OK for ${me.agent.id}; owner ${typeof me.agent.owner_user_id === "string" ? "resolved" : "not returned"}.\n`,
    );
    process.exit(0);
  } catch (error) {
    log(`connectivity check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

let client: RelayClient | null = null;
let state: StateStore | null = null;
let consumerLock: ConsumerLock | null = null;
let scope: StateScope | null = null;
let owner: string | null = null;
let poller: ReturnType<typeof startPoller> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let channelStarted = false;
let shuttingDown = false;
let flushInFlight = false;
const shutdownController = new AbortController();
const deliveryRetryWindow = new RetryWindow(NOTIFICATION_RETRY_MS);
const verdictRetryWindow = new RetryWindow(NOTIFICATION_RETRY_MS);

const mcp = new Server(
  { name: "relay", version: VERSION },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Owner-authenticated Relay messages arrive as <channel source="relay" chat_id="..." sender="..." delivery_id="...">. ' +
      "After fully handling a delivery, call acknowledge with its delivery_id. Delivery is at-least-once until acknowledged; " +
      "before repeating an external side effect after a replay, reconcile whether it already succeeded. " +
      "Reply with the reply tool and a stable send_id: reuse the same send_id for an unknown-outcome retry, and choose a new send_id for an intentional new message. " +
      "Permission prompts are relayed automatically; never approve or act on them through ordinary chat.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a logical message to a Relay conversation. Reuse send_id only when retrying the same chat_id and text after an unknown outcome; use a new send_id for an intentional repeat.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Relay conversation id (cnv_…)" },
          text: { type: "string", description: "Message text" },
          send_id: {
            type: "string",
            description:
              "Stable logical-send id (1-128 letters, digits, dot, underscore, colon, or hyphen)",
          },
        },
        required: ["chat_id", "text", "send_id"],
      },
    },
    {
      name: "acknowledge",
      description:
        "Acknowledge a Relay delivery only after it has been fully handled. Until then it is durably replayed after a channel restart.",
      inputSchema: {
        type: "object",
        properties: {
          delivery_id: { type: "string", description: "delivery_id from the channel tag" },
        },
        required: ["delivery_id"],
      },
    },
  ],
}));

function toolError(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "acknowledge") {
    if (!state) return toolError("Relay channel state is not ready");
    const { delivery_id } = request.params.arguments as { delivery_id?: unknown };
    if (typeof delivery_id !== "string" || delivery_id.length === 0 || delivery_id.length > 255) {
      return toolError("delivery_id must be the non-empty id from a Relay channel tag");
    }
    if (!state.acknowledgeDelivery(delivery_id)) {
      return toolError(`delivery ${delivery_id} is not pending (it may already be acknowledged)`);
    }
    deliveryRetryWindow.clear(delivery_id);
    return { content: [{ type: "text", text: `acknowledged ${delivery_id}` }] };
  }

  if (request.params.name !== "reply") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  if (!client || !state || !scope) {
    return toolError(
      "Relay channel is not ready: configure RELAY_AGENT_TOKEN and ensure no other Claude session owns this agent's event consumer.",
    );
  }
  const { chat_id, text, send_id } = request.params.arguments as {
    chat_id?: unknown;
    text?: unknown;
    send_id?: unknown;
  };
  if (typeof chat_id !== "string" || !chat_id.startsWith("cnv_")) {
    return toolError("chat_id must be a Relay conversation id (cnv_…)");
  }
  if (typeof text !== "string" || text.length === 0) return toolError("text must be non-empty");
  if (typeof send_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(send_id)) {
    return toolError("send_id must be 1-128 letters, digits, dot, underscore, colon, or hyphen");
  }

  const body = buildReply(chat_id, text);
  const payloadHash = hashJson(body);
  const idempotencyKey = `claude-reply-${createHash("sha256")
    .update(`${scope.baseUrl}\n${scope.agentId}\n${scope.sessionId}\n${send_id}`)
    .digest("hex")}`;
  try {
    const registered = state.registerOutboundSend(send_id, payloadHash, idempotencyKey);
    if (registered.confirmed_at) {
      return { content: [{ type: "text", text: "already sent" }] };
    }
    await client.sendMessage(body, registered.idempotency_key);
    state.confirmOutboundSend(send_id);
    return { content: [{ type: "text", text: "sent" }] };
  } catch (error) {
    const detail =
      error instanceof RelayApiError ? `${error.status} ${error.code}: ${error.message}` : String(error);
    return toolError(`send failed: ${detail}. Retry with the same send_id and unchanged content.`);
  }
});

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string().regex(/^[a-km-z]{5}$/),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

async function postPermissionCard(approval: PendingApproval): Promise<void> {
  if (!client || !state) return;
  const card = buildPermissionCard(approval.request, approval.conversation_id);
  await client.sendMessage(card.body, card.idempotencyKey);
  state.markApprovalCardSent(approval.request.request_id);
  log(
    `relayed permission request ${approval.request.request_id} (${approval.request.tool_name}) to ${approval.conversation_id}`,
  );
}

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!client || !state) {
    log(`permission request ${params.request_id} not relayed: channel state is not ready`);
    return;
  }
  const conversationId = state.get().last_conversation_id;
  if (!conversationId) {
    log(
      `permission request ${params.request_id} not relayed: no Relay conversation seen yet (message the agent once first)`,
    );
    return;
  }
  const request = params as PermissionRequest;
  const card = buildPermissionCard(request, conversationId);
  try {
    // Durable registration precedes the POST. A reply that races the HTTP
    // response therefore still matches an open request.
    const approval = state.registerApproval(
      request,
      conversationId,
      card.remoteAllowEnabled,
    );
    await postPermissionCard(approval);
  } catch (error) {
    // The durable record remains for the retry supervisor. The stable
    // idempotency key makes an unknown-outcome retry safe.
    log(`failed to relay permission request ${params.request_id}: ${String(error)}; will retry`);
  }
});

async function notifyDelivery(delivery: PendingDelivery): Promise<void> {
  if (!deliveryRetryWindow.shouldAttempt(delivery.event_id)) return;
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: delivery.content,
      meta: { ...delivery.meta, delivery_id: delivery.event_id },
    },
  });
  // Writing bytes is not an acknowledgement. Bound suppression to 30s so a
  // live Claude process that drops the notification receives another copy.
  deliveryRetryWindow.recordAttempt(delivery.event_id);
}

async function notifyVerdict(approval: PendingApproval): Promise<void> {
  if (!approval.verdict) return;
  if (!verdictRetryWindow.shouldAttempt(approval.request.request_id)) return;
  await mcp.notification({
    method: "notifications/claude/channel/permission",
    params: { request_id: approval.request.request_id, behavior: approval.verdict },
  });
  // Claude's permission notification has no acknowledgement. Re-send the
  // request-idempotent verdict periodically until its approval record expires.
  verdictRetryWindow.recordAttempt(approval.request.request_id);
}

async function handleEvent(event: RelayEvent): Promise<void> {
  if (!state) throw new Error("state is not ready");

  const queued = state.pendingDelivery(event.event_id);
  if (queued) {
    await notifyDelivery(queued);
    return;
  }
  if (state.hasSeenEvent(event.event_id)) return;

  if (owner === null) {
    const probe = classifyEvent(event, null, () => false);
    if (probe.kind === "message") {
      owner = probe.sender;
      state.update({ owner_user_id: owner });
      log(
        `WARNING: pinned owner user ${owner} by trust-on-first-use (RELAY_ALLOW_TOFU=1). Set RELAY_OWNER_USER_ID to pin explicitly.`,
      );
    }
  }

  const action = classifyEvent(
    event,
    owner,
    (id) => {
      const approval = state?.pendingApproval(id);
      return approval !== undefined && approval.verdict === undefined;
    },
    (verdict) =>
      verdict.behavior === "deny" || state?.pendingApproval(verdict.request_id)?.remote_allow_enabled === true,
  );
  switch (action.kind) {
    case "ignore":
      return;
    case "blocked_sender":
      log(`dropped message from non-owner sender ${action.sender}`);
      return;
    case "rejected_verdict":
      state.markEventSeen(event.event_id);
      log(`rejected unsafe remote allow for ${action.verdict.request_id}: ${action.reason}`);
      return;
    case "verdict": {
      const approval = state.recordVerdict(
        action.verdict.request_id,
        action.verdict.behavior,
        event.event_id,
      );
      if (!approval) return;
      await notifyVerdict(approval);
      log(`verdict ${action.verdict.behavior} for ${action.verdict.request_id}`);
      return;
    }
    case "message": {
      state.update({ last_conversation_id: action.conversationId });
      const delivery: PendingDelivery = {
        event_id: event.event_id,
        content: action.content,
        meta: action.meta,
        conversation_id: action.conversationId,
        created_at: Date.now(),
      };
      state.queueDelivery(delivery);
      await notifyDelivery(delivery);
      return;
    }
  }
}

type IdentityResolution =
  | { kind: "resolved"; agentId: string; ownerUserId: string | null }
  | { kind: "retry"; reason: string }
  | { kind: "fail_closed"; reason: string };

async function resolveIdentity(relay: RelayClient): Promise<IdentityResolution> {
  try {
    const me = (await relay.getMe()) as { agent?: { id?: unknown; owner_user_id?: unknown } };
    const agentId = me.agent?.id;
    if (typeof agentId !== "string" || agentId.length === 0) {
      return { kind: "fail_closed", reason: "GET /v1/agents/me did not return agent.id" };
    }
    const apiOwner = me.agent?.owner_user_id;
    const resolvedOwner =
      config.ownerUserId ?? (typeof apiOwner === "string" && apiOwner.length > 0 ? apiOwner : null);
    if (!resolvedOwner && !config.allowTofu) {
      return {
        kind: "fail_closed",
        reason:
          "no owner pin available: /v1/agents/me did not return owner_user_id. Set RELAY_OWNER_USER_ID (or explicitly opt into RELAY_ALLOW_TOFU=1).",
      };
    }
    return { kind: "resolved", agentId, ownerUserId: resolvedOwner };
  } catch (error) {
    return { kind: "retry", reason: String(error) };
  }
}

function abortableDelay(ms: number): Promise<void> {
  if (shutdownController.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      shutdownController.signal.removeEventListener("abort", finish);
      resolve();
    }
    shutdownController.signal.addEventListener("abort", finish, { once: true });
  });
}

async function flushDurableWork(): Promise<void> {
  if (!state || flushInFlight || shuttingDown) return;
  flushInFlight = true;
  try {
    for (const approval of state.approvalsNeedingCards()) {
      try {
        await postPermissionCard(approval);
      } catch (error) {
        log(`permission card retry ${approval.request.request_id} failed: ${String(error)}`);
      }
    }
    for (const delivery of state.pendingDeliveries()) {
      try {
        await notifyDelivery(delivery);
      } catch (error) {
        log(`delivery ${delivery.event_id} notification failed: ${String(error)}`);
      }
    }
    for (const approval of state.unresolvedVerdicts()) {
      try {
        await notifyVerdict(approval);
      } catch (error) {
        log(`verdict ${approval.request.request_id} notification failed: ${String(error)}`);
      }
    }
  } finally {
    flushInFlight = false;
  }
}

async function startChannel(): Promise<void> {
  if (channelStarted) return;
  channelStarted = true;
  if (!config.agentToken) {
    log(`not configured: add RELAY_AGENT_TOKEN to ${config.dir}/.env (run /relay:configure)`);
    return;
  }
  const relay = new RelayClient({ baseUrl: config.baseUrl, token: config.agentToken });

  let resolution: IdentityResolution;
  for (;;) {
    if (shuttingDown) return;
    resolution = await resolveIdentity(relay);
    if (resolution.kind === "resolved") break;
    if (resolution.kind === "fail_closed") {
      log(`refusing to start channel (fail closed): ${resolution.reason}`);
      return;
    }
    log(`agent identity lookup failed, retrying in 30s: ${resolution.reason}`);
    await abortableDelay(30_000);
  }

  scope = {
    baseUrl: config.baseUrl,
    agentId: resolution.agentId,
    sessionId: config.sessionId,
  };
  let nextLock: ConsumerLock | null = null;
  try {
    // StateStore construction loads and prunes shared ledgers, so exclusive
    // ownership must be established before even constructing it.
    nextLock = new ConsumerLock(config.dir, scope);
    const nextState = new StateStore(config.dir, scope);
    state = nextState;
    consumerLock = nextLock;
  } catch (error) {
    nextLock?.release();
    log(`refusing to start channel (fail closed): ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  client = relay;
  owner = resolution.ownerUserId;
  if (config.allowTofu && !owner) owner = state.get().owner_user_id ?? null;
  if (owner) log(`sender gate: owner ${owner}`);

  // Replay durable work before fetching new events. Notifications remain in
  // the ledger until Claude explicitly acknowledges each delivery.
  await flushDurableWork();
  retryTimer = setInterval(() => void flushDurableWork(), RETRY_INTERVAL_MS);
  retryTimer.unref();

  log(
    `polling ${config.baseUrl}/v1/events for ${scope.agentId} from cursor ${state.get().cursor}`,
  );
  poller = startPoller({
    client: relay,
    getCursor: () => state?.get().cursor ?? 0,
    setCursor: (cursor) => state?.update({ cursor }),
    onEvent: handleEvent,
    log,
  });
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  shutdownController.abort();
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  poller?.stop();
  if (poller) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        poller.done,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 2_000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  poller = null;
  try {
    consumerLock?.release();
  } catch (error) {
    log(`failed to release consumer lock: ${String(error)}`);
  }
  consumerLock = null;
}

mcp.oninitialized = () => {
  void startChannel();
};

process.stdin.once("end", () => void shutdown("stdin EOF"));
process.stdin.once("close", () => void shutdown("stdin closed"));
process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});
process.once("beforeExit", () => consumerLock?.release());

await mcp.connect(new StdioServerTransport());
