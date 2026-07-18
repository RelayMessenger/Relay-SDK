/**
 * Codex-side entrypoints installed by `relayapp install-codex`:
 *
 * `relayapp notify` — Codex appends its notification JSON as the final argv
 * arg (kebab-case): {"type":"agent-turn-complete","thread-id":…,"turn-id":…,
 * "cwd":…,"input-messages":[…],"last-assistant-message":…}. That is the only
 * notify event Codex emits; approvals come through the PermissionRequest hook.
 *
 * `relayapp hook permission-request` — Codex's hooks engine pipes
 * {session_id, turn_id, cwd, tool_name, tool_input, permission_mode} on stdin
 * and accepts a decision on stdout:
 *   exit 0 + {"hookSpecificOutput":{"decision":{"behavior":"allow"|"deny"}}}
 *   exit 0 + no decision → fall through to Codex's normal approval flow
 * The hook posts an Allow/Deny card to Relay and blocks on the phone tap
 * (watching its per-request approval file — which a running `relayapp start`
 * loop resolves — and polling the conversation directly). Timeout → deny.
 *
 * These entrypoints run in their own processes and never write state.json;
 * that file is owned exclusively by the `start` loop. They read the pinned
 * owner conversation via readStateSnapshot() and coordinate approvals only
 * through per-request files in ~/.relayapp/approvals/.
 */
import { randomBytes } from "node:crypto";
import { RelayClient } from "./api.js";
import { buildPermissionCard, newRequestId, verdictFromMessage } from "./permissions.js";
import {
  ApprovalStore,
  ConfigStore,
  readStateSnapshot,
  resolveOwnerUserId,
  type PendingApproval,
} from "./store.js";

export function requireClient(config = new ConfigStore()): {
  client: RelayClient;
  ownerUserId?: string;
  conversationId?: string;
} {
  const loaded = config.load();
  if (!loaded?.agent_token) {
    throw new Error("Not paired. Run `relayapp pair` first.");
  }
  let ownerUserId: string | undefined;
  try {
    ownerUserId = resolveOwnerUserId(loaded);
  } catch {
    ownerUserId = undefined;
  }
  return {
    client: new RelayClient(loaded.api_origin, loaded.agent_token),
    ownerUserId,
    // The owner's conversation, pinned by the loop at the first owner
    // message — never the most recent writer.
    conversationId: readStateSnapshot().owner_conversation_id,
  };
}

export async function notifyCommand(argv: string[], out: (line: string) => void = console.log): Promise<void> {
  const raw = argv[argv.length - 1];
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Not JSON — treat as free text.
    payload = { "last-assistant-message": raw };
  }
  if (payload.type && payload.type !== "agent-turn-complete") return;

  const { client, conversationId } = requireClient();
  if (!conversationId) {
    out(
      "relayapp notify: no pinned owner conversation yet — run `relayapp start` once and " +
        "message the agent from the Relay app first.",
    );
    return;
  }
  const last = payload["last-assistant-message"];
  const inputs: string[] = Array.isArray(payload["input-messages"]) ? payload["input-messages"] : [];
  const summary = typeof last === "string" && last.trim().length > 0
    ? last.trim()
    : `Codex finished a turn${inputs.length > 0 ? ` on: ${inputs[0]}` : ""}.`;
  const turnId = payload["turn-id"] ?? randomBytes(6).toString("hex");
  await client.postMessage(
    {
      conversation_id: conversationId,
      parts: [{ type: "text", text: `Codex (${payload.cwd ?? "local"}): ${summary}`.slice(0, 7900) }],
    },
    `relay-notify-${turnId}`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HOOK_TIMEOUT_MS = 9 * 60 * 1000; // under Codex's 600 s handler default

export async function permissionRequestHook(
  write: (json: unknown) => void = (json) => process.stdout.write(`${JSON.stringify(json)}\n`),
): Promise<number> {
  let input: any = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0; // Unparseable input → no decision, Codex falls back to local approval.
  }

  const config = new ConfigStore().load();
  const conversationId = readStateSnapshot().owner_conversation_id;
  let ownerUserId: string | undefined;
  try {
    ownerUserId = config ? resolveOwnerUserId(config) : undefined;
  } catch {
    ownerUserId = undefined;
  }
  if (!config?.agent_token || !conversationId || !ownerUserId) {
    // Not paired / no pinned owner or conversation → we cannot verify who
    // would answer, so fall through to Codex's local approval flow.
    return 0;
  }
  const client = new RelayClient(config.api_origin, config.agent_token);
  const approvals = new ApprovalStore();

  const requestId = newRequestId();
  const approval: PendingApproval = {
    request_id: requestId,
    conversation_id: conversationId,
    engine: "codex",
    tool_name: input.tool_name,
    created_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + HOOK_TIMEOUT_MS).toISOString(),
    options: [
      { option_id: "allow", label: "Allow", kind: "allow_once" },
      { option_id: "deny", label: "Deny", kind: "reject_once" },
    ],
    source: "hook",
  };
  // Durable (create-once) before the card goes out. A running `relayapp
  // start` loop sees the tap on the event stream and writes the resolution
  // into this file; this process is the waiter that consumes it.
  approvals.create(approval);

  const card = buildPermissionCard({
    requestId,
    conversationId,
    engineLabel: "Codex",
    toolName: input.tool_name,
    inputPreview:
      input.tool_input !== undefined ? JSON.stringify(input.tool_input).slice(0, 1500) : undefined,
  });
  const posted = await client.postMessage(card.body, card.idempotencyKey);
  const cardSequence = posted.message.sequence;

  const finish = (allow: boolean): number => {
    approvals.consume(requestId);
    write(decisionJson(allow));
    return 0;
  };

  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // Path 1: a running start loop resolved our approval file.
    const shared = approvals.get(requestId);
    if (shared?.resolution) return finish(shared.resolution.behavior === "allow");
    if (!shared) {
      // Aged out from under us — treat as deny.
      break;
    }
    // Path 2: poll the conversation directly (works without `relayapp start`).
    try {
      const { messages } = await client.listMessages(conversationId, 10);
      const verdict = messages
        .filter(
          (message) =>
            message.sender.kind === "user" &&
            message.sender.id === ownerUserId &&
            message.conversation_id === conversationId &&
            message.sequence > cardSequence,
        )
        .sort((a, b) => a.sequence - b.sequence)
        .map((message) => verdictFromMessage(message))
        .find((candidate) => candidate?.request_id === requestId);
      if (verdict) return finish(verdict.behavior === "allow");
    } catch {
      // transient — keep polling until deadline
    }
  }

  process.stderr.write("relayapp: no approval from Relay within the window — denying.\n");
  return finish(false);
}

function decisionJson(allow: boolean): unknown {
  return { hookSpecificOutput: { decision: { behavior: allow ? "allow" : "deny" } } };
}
