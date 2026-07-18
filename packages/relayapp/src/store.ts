/**
 * Durable local state for the relayapp bridge.
 *
 * Everything lives under ~/.relayapp (override with RELAYAPP_HOME):
 *   config.json    — agent token, API origin, owner_user_id (chmod 600)
 *   state.json     — receive cursor, dedupe set, pending events. EXCLUSIVELY
 *                    owned (written) by the `start` loop process; other
 *                    entrypoints (codex hook, notify, mcp) may only read it
 *                    via readStateSnapshot().
 *   approvals/<request_id>.json — one file per pending approval (create-once
 *                    by whoever arms it, resolution written by the loop,
 *                    consumed+unlinked by the waiter). No read-modify-write
 *                    of shared snapshots across processes.
 *   sessions.json  — conversation_id → engine session binding
 *
 * Writes are atomic: content is fsync'd to a tmp file, then renamed into
 * place, so a crash can never leave a half-written file. Cursor + pending
 * queue share one file, so the durable-before-ack invariant holds with a
 * single atomic write.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function relayappHome(): string {
  return process.env.RELAYAPP_HOME ?? join(homedir(), ".relayapp");
}

export interface RelayConfig {
  api_origin: string;
  agent_token: string;
  /**
   * The Relay user id allowed to drive this bridge. Pinned at pair time from
   * GET /v1/agents/me; overridable with RELAY_OWNER_USER_ID. Everything the
   * bridge does — prompts, approvals, notify targets — is gated on it.
   */
  owner_user_id?: string;
  agent?: { id?: string; handle?: string; display_name?: string };
  paired_at?: string;
  /**
   * Optional operator-run opencode server for `--engine opencode` attach
   * mode. Absent → the bridge spawns `opencode serve` itself. Env overrides:
   * OPENCODE_SERVER_URL / OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD.
   */
  opencode?: { server_url?: string; username?: string; password?: string };
}

/** Resolve the pinned owner, failing closed when it is missing. */
export function resolveOwnerUserId(config: RelayConfig | undefined): string {
  const owner = process.env.RELAY_OWNER_USER_ID ?? config?.owner_user_id;
  if (!owner) {
    throw new Error(
      "No pinned owner_user_id. Re-run `relayapp pair` against a server that reports " +
        "the agent owner, or set RELAY_OWNER_USER_ID explicitly.",
    );
  }
  return owner;
}

export interface PendingApproval {
  request_id: string;
  conversation_id: string;
  engine?: string;
  tool_name?: string;
  created_at: string;
  /** ISO time after which the approval is denied. */
  deadline_at: string;
  /** Relay message id of the card, for reply_to matching. */
  relay_message_id?: string;
  options: Array<{ option_id: string; label: string; kind?: string }>;
  source: "acp" | "hook";
  resolution?: { option_id?: string; behavior: "allow" | "deny" | "cancelled"; decided_at: string };
}

export interface RelayEvent {
  event_id: string;
  event_type: string;
  agent_id?: string;
  created_at?: string;
  data?: { message?: RelayMessage; [key: string]: unknown };
}

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: { kind: "user" | "agent"; id: string };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
  fallback_text: string;
  reply_to?: { message_id?: string; part_index?: number } | null;
  created_at?: string;
}

export interface BridgeState {
  cursor: number;
  seen_event_ids: string[];
  pending_events: Record<string, RelayEvent[]>;
  /**
   * The owner's conversation with this agent, persisted by the loop when the
   * first owner message arrives. Default target for notify/MCP sends. Never
   * derived from the most recent writer.
   */
  owner_conversation_id?: string;
}

export interface SessionBinding {
  engine: string;
  session_id: string;
  cwd: string;
  created_at: string;
}

const SEEN_CAP = 2000;

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function atomicWriteJson(path: string, value: unknown, mode: number): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd); // content durable before the rename makes it visible
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Rename preserves the tmp file's mode, but tighten in case of umask quirks.
  chmodSync(path, mode);
}

export class ConfigStore {
  constructor(private readonly home = relayappHome()) {}

  get path(): string {
    return join(this.home, "config.json");
  }

  load(): RelayConfig | undefined {
    return readJson<RelayConfig>(this.path);
  }

  save(config: RelayConfig): void {
    atomicWriteJson(this.path, config, 0o600);
  }
}

function normalizeState(raw: Partial<BridgeState>): BridgeState {
  return {
    cursor: typeof raw.cursor === "number" ? raw.cursor : 0,
    seen_event_ids: Array.isArray(raw.seen_event_ids) ? raw.seen_event_ids : [],
    pending_events: raw.pending_events ?? {},
    owner_conversation_id: raw.owner_conversation_id,
  };
}

/**
 * Read-only view of state.json for non-loop processes (hook, notify, mcp).
 * Those processes MUST NOT construct a StateStore: only the `start` loop
 * writes state.json.
 */
export function readStateSnapshot(home = relayappHome()): BridgeState {
  return normalizeState(readJson<Partial<BridgeState>>(join(home, "state.json")) ?? {});
}

export class StateStore {
  private state: BridgeState;

  constructor(private readonly home = relayappHome()) {
    this.state = normalizeState(readJson<Partial<BridgeState>>(this.path) ?? {});
  }

  get path(): string {
    return join(this.home, "state.json");
  }

  get current(): BridgeState {
    return this.state;
  }

  markSeen(eventId: string): void {
    this.state.seen_event_ids.push(eventId);
    if (this.state.seen_event_ids.length > SEEN_CAP) {
      this.state.seen_event_ids = this.state.seen_event_ids.slice(-SEEN_CAP);
    }
  }

  hasSeen(eventId: string): boolean {
    return this.state.seen_event_ids.includes(eventId);
  }

  persist(): void {
    atomicWriteJson(this.path, this.state, 0o600);
  }
}

/**
 * Per-request approval files: ~/.relayapp/approvals/<request_id>.json.
 * Create-once by whoever arms the approval (loop or codex hook), resolution
 * written by the loop when the tap arrives, consumed + unlinked by the waiter.
 * Each file has a single writer at a time, so there is no read-modify-write
 * of a shared snapshot across processes.
 */
export class ApprovalStore {
  constructor(private readonly home = relayappHome()) {}

  get dir(): string {
    return join(this.home, "approvals");
  }

  private pathFor(requestId: string): string {
    if (!/^[a-z0-9_-]+$/i.test(requestId)) throw new Error(`invalid request id: ${requestId}`);
    return join(this.dir, `${requestId}.json`);
  }

  /** Create-once: throws if the request id already exists. */
  create(approval: PendingApproval): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.pathFor(approval.request_id);
    const fd = openSync(path, "wx", 0o600); // wx: fail on collision
    try {
      writeSync(fd, `${JSON.stringify(approval, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  get(requestId: string): PendingApproval | undefined {
    return readJson<PendingApproval>(this.pathFor(requestId));
  }

  /** Full rewrite of one approval file (single-writer per file by protocol). */
  put(approval: PendingApproval): void {
    atomicWriteJson(this.pathFor(approval.request_id), approval, 0o600);
  }

  /** The waiter consumes the decision by removing the file. */
  consume(requestId: string): void {
    try {
      unlinkSync(this.pathFor(requestId));
    } catch {
      // already gone — consuming twice is harmless
    }
  }

  list(): PendingApproval[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const approvals: PendingApproval[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const approval = readJson<PendingApproval>(join(this.dir, name));
      if (approval?.request_id) approvals.push(approval);
    }
    return approvals;
  }

  /**
   * Age out abandoned files. An unconsumed resolution belongs to a waiter in
   * another process, so nothing is removed before deadline + grace — only
   * files whose waiter has clearly given up (crashed hook, dead loop).
   */
  sweep(now = Date.now(), graceMs = 10 * 60 * 1000): string[] {
    const removed: string[] = [];
    for (const approval of this.list()) {
      const deadline = Date.parse(approval.deadline_at);
      if (Number.isFinite(deadline) && now > deadline + graceMs) {
        this.consume(approval.request_id);
        removed.push(approval.request_id);
      }
    }
    return removed;
  }
}

export class SessionStore {
  private sessions: Record<string, SessionBinding>;

  constructor(private readonly home = relayappHome()) {
    this.sessions = readJson<Record<string, SessionBinding>>(this.path) ?? {};
  }

  get path(): string {
    return join(this.home, "sessions.json");
  }

  get(conversationId: string): SessionBinding | undefined {
    return this.sessions[conversationId];
  }

  set(conversationId: string, binding: SessionBinding): void {
    this.sessions[conversationId] = binding;
    atomicWriteJson(this.path, this.sessions, 0o600);
  }

  delete(conversationId: string): void {
    delete this.sessions[conversationId];
    atomicWriteJson(this.path, this.sessions, 0o600);
  }

  all(): Record<string, SessionBinding> {
    return this.sessions;
  }
}
