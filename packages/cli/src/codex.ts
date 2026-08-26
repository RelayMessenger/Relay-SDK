/**
 * Codex-side entrypoints installed by `relaymessenger install-codex`:
 *
 * `relaymessenger notify` — Codex appends its notification JSON as the final argv
 * arg (kebab-case): {"type":"agent-turn-complete","thread-id":…,"turn-id":…,
 * "cwd":…,"input-messages":[…],"last-assistant-message":…}. That is the only
 * notify event Codex emits; approvals come through the PermissionRequest hook.
 *
 * `relaymessenger hook permission-request` — Codex's hooks engine pipes
 * {session_id, turn_id, cwd, tool_name, tool_input, permission_mode} on stdin
 * and accepts a decision on stdout (developers.openai.com/codex/hooks):
 *   exit 0 + {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 *             "decision":{"behavior":"allow"|"deny"}}}
 *   exit 0 + no decision → fall through to Codex's normal approval flow
 * The hook posts an Allow/Deny card to Relay and blocks on the phone tap
 * (watching its per-request approval file — which a running `relaymessenger start`
 * loop resolves — and polling the conversation directly). Timeout → deny.
 *
 * These entrypoints run in their own processes and never write state.json;
 * that file is owned exclusively by the `start` loop. They read the pinned
 * owner conversation via readStateSnapshot() and coordinate approvals only
 * through per-request files in the active account runtime's approvals/.
 */
import { basename, dirname } from "node:path";
import { RelayClient } from "./api.js";
import { buildPermissionCard, newRequestId, verdictFromMessage } from "./permissions.js";
import {
  ApprovalStore,
  CodexNotifyPolicyStore,
  ConfigStore,
  readStateSnapshot,
  resolveOwnerUserId,
  runtimeHomeForConfig,
  relayIdentityForConfig,
  type PendingApproval,
} from "./store.js";

export function requireClient(config = new ConfigStore()): {
  client: RelayClient;
  ownerUserId?: string;
  conversationId?: string;
  projectRoot: string;
  runtimeHome: string;
  apiOrigin: string;
  accountIdentity: string;
} {
  const projectRoot = new CodexNotifyPolicyStore().matchProject(process.cwd());
  if (!projectRoot) {
    throw new Error(
      "This project is not opted in to Relay. Run `relaymessenger install-codex` from its root first.",
    );
  }
  const loaded = config.load();
  if (!loaded?.agent_token) {
    throw new Error("Not paired. Run `relaymessenger pair` first.");
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
    conversationId: readStateSnapshot(runtimeHomeForConfig(loaded, dirname(config.path))).owner_conversation_id,
    projectRoot,
    runtimeHome: runtimeHomeForConfig(loaded, dirname(config.path)),
    apiOrigin: loaded.api_origin,
    accountIdentity: relayIdentityForConfig(loaded),
  };
}

export interface NotifyCommandDependencies {
  config?: ConfigStore;
  policy?: CodexNotifyPolicyStore;
  client?: RelayClient;
}

export async function notifyCommand(
  argv: string[],
  out: (line: string) => void = console.log,
  dependencies: NotifyCommandDependencies = {},
): Promise<void> {
  const raw = argv[argv.length - 1];
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Not JSON — treat as free text.
    payload = { "last-assistant-message": raw };
  }
  if (payload.type && payload.type !== "agent-turn-complete") return;

  const projectRoot = (dependencies.policy ?? new CodexNotifyPolicyStore()).matchProject(payload.cwd);
  if (!projectRoot) {
    out("relaymessenger notify: suppressed; this project was not explicitly opted in.");
    return;
  }
  const config = dependencies.config ?? new ConfigStore();
  const loaded = config.load();
  if (!loaded?.agent_token) throw new Error("Not paired. Run `relaymessenger pair` first.");
  const conversationId = readStateSnapshot(
    runtimeHomeForConfig(loaded, dirname(config.path)),
  ).owner_conversation_id;
  const client = dependencies.client ?? new RelayClient(loaded.api_origin, loaded.agent_token);
  if (!conversationId) {
    out(
      "relaymessenger notify: no pinned owner conversation yet; run `relaymessenger start` once and " +
        "message the agent from the Relay app first.",
    );
    return;
  }
  const last = payload["last-assistant-message"];
  const summary = typeof last === "string" && last.trim().length > 0
    ? last.trim()
    : "Codex finished a turn.";
  await client.postMessage({
    conversation_id: conversationId,
    parts: [{ type: "text", text: `Codex (${basename(projectRoot)}): ${summary}`.slice(0, 7900) }],
  });
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
  const projectRoot = new CodexNotifyPolicyStore().matchProject(input.cwd);
  if (!projectRoot) return 0;
  const conversationId = config?.agent_token
    ? readStateSnapshot(runtimeHomeForConfig(config)).owner_conversation_id
    : undefined;
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
  let card: ReturnType<typeof buildPermissionCard>;
  try {
    card = buildPermissionCard({
      requestId,
      conversationId,
      engineLabel: "Codex",
      toolName: input.tool_name,
      inputPreview: input.tool_input !== undefined ? JSON.stringify(input.tool_input) : undefined,
    });
  } catch (error) {
    process.stderr.write(`relaymessenger: refusing concealed approval input (${error}); denying.\n`);
    write(decisionJson(false));
    return 0;
  }

  // Durable (create-once) before the card goes out, carrying the id the card
  // commits under so a repost cannot stack a second card. A running
  // `relaymessenger start` loop sees the tap on the event stream and writes
  // the resolution into this file; this process is the waiter that consumes it.
  approval.relay_message_id = card.body.message_id;
  approvals.create(approval);

  let posted;
  try {
    posted = await client.postMessage(card.body);
  } catch (error) {
    approvals.consume(requestId);
    process.stderr.write(`relaymessenger: approval card could not be delivered (${error}); denying.\n`);
    write(decisionJson(false));
    return 0;
  }
  // A verdict must come after the card, so the card's own sequence is the
  // watermark the scan is gated on. A response without one would leave a zero
  // default that accepts any earlier matching message, so refuse instead.
  const cardSequence = posted.message?.sequence;
  if (cardSequence === undefined) {
    approvals.consume(requestId);
    process.stderr.write(
      "relaymessenger: approval card send returned no committed message; denying.\n",
    );
    write(decisionJson(false));
    return 0;
  }

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
    // Path 2: poll the conversation directly (works without `relaymessenger start`).
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

  process.stderr.write("relaymessenger: no approval from Relay within the window; denying.\n");
  return finish(false);
}

/**
 * Exact PermissionRequest hook envelope from the Codex hooks reference:
 * hookSpecificOutput.hookEventName is required — without it Codex treats the
 * output as invalid and the phone decision is dropped.
 */
export function decisionJson(allow: boolean): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Denied from the Relay app." },
    },
  };
}
