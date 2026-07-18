/**
 * Durable local state for the relayapp bridge.
 *
 * Everything lives under ~/.relayapp (override with RELAYAPP_HOME):
 *   config.json    — active agent token, API origin, owner_user_id (chmod 600)
 *   accounts/<origin-agent-hash>/state.json — receive cursor, dedupe set,
 *                    pending events. EXCLUSIVELY
 *                    owned (written) by the `start` loop process; other
 *                    entrypoints (codex hook, notify, mcp) may only read it
 *                    via readStateSnapshot().
 *   accounts/<hash>/approvals/<request_id>.json — pending approval (create-once
 *                    by whoever arms it, resolution written by the loop,
 *                    consumed+unlinked by the waiter). No read-modify-write
 *                    of shared snapshots across processes.
 *   accounts/<hash>/sessions.json — conversation_id → engine session binding
 *
 * Writes are atomic: content is fsync'd to a tmp file, then renamed into
 * place, so a crash can never leave a half-written file. Cursor + pending
 * queue share one file, so the durable-before-ack invariant holds with a
 * single atomic write.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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

/** Stable, non-secret identity label used inside account-scoped ledgers. */
export function relayIdentityForConfig(
  config: Pick<RelayConfig, "agent_token" | "agent">,
): string {
  if (config.agent?.id) return `agent:${config.agent.id}`;
  if (!config.agent_token) throw new Error("Cannot identify Relay account without an agent token.");
  return `token:${createHash("sha256").update(config.agent_token).digest("hex")}`;
}

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

/**
 * Durable bridge state is scoped to one authenticated Relay identity. The
 * agent id is preferred; a token fingerprint is the fail-safe fallback for
 * legacy servers that do not expose it. Raw tokens/origins never enter paths.
 */
export function runtimeHomeForConfig(
  config: Pick<RelayConfig, "api_origin" | "agent_token" | "agent">,
  baseHome = relayappHome(),
): string {
  if (!config.api_origin || !config.agent_token) {
    throw new Error("Cannot select Relay runtime state without a paired origin and agent token.");
  }
  const identity = relayIdentityForConfig(config);
  const namespace = createHash("sha256")
    .update(`${canonicalOrigin(config.api_origin)}\0${identity}`)
    .digest("hex")
    .slice(0, 40);
  return join(baseHome, "accounts", namespace);
}

export function activeRuntimeHome(baseHome = relayappHome()): string {
  const config = new ConfigStore(baseHome).load();
  if (!config?.agent_token) throw new Error("Not paired. Run `relayapp pair` first.");
  return runtimeHomeForConfig(config, baseHome);
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
   * conversation_id → turn idempotency key persisted immediately BEFORE the
   * engine turn starts and cleared on success. A marker found at startup means
   * a previous process crashed mid-turn: that batch is dropped with a notice
   * instead of re-executed, so engine/tool side effects (deploys, deletions,
   * sends) run at most once per owner message.
   */
  attempted_turns?: Record<
    string,
    { turn_key: string; event_ids: string[]; started_at: string }
  >;
  /**
   * Engine-completed replies waiting for idempotent Relay delivery. The full
   * reply is persisted before the POST, so a restart can redeliver it without
   * executing the engine or its tools again.
   */
  pending_replies?: Record<
    string,
    { conversation_id: string; event_ids: string[]; text: string; created_at: string }
  >;
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

function stateBlockedPath(home: string): string {
  return join(home, "state.blocked.json");
}

function blockInvalidState(home: string, path: string, reason: string): never {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const blocked = stateBlockedPath(home);
  const quarantined = `${path}.corrupt-${Date.now()}-${process.pid}`;
  try {
    renameSync(path, quarantined);
  } catch {
    // The persistent block remains the fail-closed boundary.
  }
  atomicWriteJson(
    blocked,
    { blocked_at: new Date().toISOString(), reason, quarantined },
    0o600,
  );
  throw new Error(`Invalid Relay runtime state was quarantined; startup is blocked (${blocked}).`);
}

function bridgeStateIsValid(raw: Partial<BridgeState>): boolean {
  const objectOfArrays = (value: unknown, itemValid: (item: any) => boolean) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (items) => Array.isArray(items) && items.every((item) => itemValid(item)),
    );
  const objectOfRecords = (value: unknown, recordValid: (item: any) => boolean) =>
    value === undefined ||
    (!!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(recordValid));
  return (
    Number.isSafeInteger(raw.cursor) &&
    (raw.cursor as number) >= 0 &&
    Array.isArray(raw.seen_event_ids) &&
    raw.seen_event_ids.every((id) => typeof id === "string") &&
    objectOfArrays(
      raw.pending_events,
      (event) =>
        !!event && typeof event.event_id === "string" && typeof event.event_type === "string",
    ) &&
    objectOfRecords(
      raw.attempted_turns,
      (attempt) =>
        !!attempt &&
        typeof attempt.turn_key === "string" &&
        typeof attempt.started_at === "string" &&
        Array.isArray(attempt.event_ids) &&
        attempt.event_ids.length > 0 &&
        attempt.event_ids.every((id: unknown) => typeof id === "string"),
    ) &&
    objectOfRecords(
      raw.pending_replies,
      (reply) =>
        !!reply &&
        typeof reply.conversation_id === "string" &&
        typeof reply.text === "string" &&
        typeof reply.created_at === "string" &&
        Array.isArray(reply.event_ids) &&
        reply.event_ids.every((id: unknown) => typeof id === "string"),
    ) &&
    (raw.owner_conversation_id === undefined || typeof raw.owner_conversation_id === "string")
  );
}

function loadBridgeState(home: string): BridgeState {
  const path = join(home, "state.json");
  const blocked = stateBlockedPath(home);
  if (existsSync(blocked)) {
    throw new Error(
      `Relay runtime state is blocked after corruption (${blocked}). ` +
        "Inspect the quarantined state and re-pair or remove the account state deliberately.",
    );
  }
  let raw: Partial<BridgeState> | undefined;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeState>;
  } catch (error: any) {
    if (error?.code === "ENOENT") return normalizeState({});
    return blockInvalidState(home, path, "state.json could not be parsed");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return blockInvalidState(home, path, "state.json root is not an object");
  }
  if (!bridgeStateIsValid(raw)) {
    return blockInvalidState(home, path, "state.json fields violate the durable state schema");
  }
  return normalizeState(raw);
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
    attempted_turns: raw.attempted_turns ?? {},
    pending_replies: raw.pending_replies ?? {},
    owner_conversation_id: raw.owner_conversation_id,
  };
}

/**
 * Read-only view of state.json for non-loop processes (hook, notify, mcp).
 * Those processes MUST NOT construct a StateStore: only the `start` loop
 * writes state.json.
 */
export function readStateSnapshot(home?: string): BridgeState {
  return loadBridgeState(home ?? activeRuntimeHome());
}

export class StateStore {
  private state: BridgeState;

  constructor(private readonly home = activeRuntimeHome()) {
    this.state = loadBridgeState(this.home);
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
 * Per-request approval files in the active account runtime directory.
 * Create-once by whoever arms the approval (loop or codex hook), resolution
 * written by the loop when the tap arrives, consumed + unlinked by the waiter.
 * Each file has a single writer at a time, so there is no read-modify-write
 * of a shared snapshot across processes.
 */
export class ApprovalStore {
  constructor(private readonly home = activeRuntimeHome()) {}

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

export interface McpOutboundSend {
  send_id: string;
  api_origin: string;
  account_identity: string;
  conversation_id: string;
  payload_hash: string;
  idempotency_key: string;
  created_at: string;
  confirmed_at?: string;
}

/**
 * Create-once ledger for Codex MCP logical sends. Each caller-provided send_id
 * is permanently bound to one account, origin, conversation, and exact body.
 * An ambiguous POST can therefore be repeated after a process restart with
 * the same server idempotency key, while changed content fails closed.
 */
export class McpSendLedger {
  constructor(
    private readonly home: string,
    private readonly apiOrigin: string,
    private readonly accountIdentity: string,
  ) {}

  get dir(): string {
    return join(this.home, "mcp-sends");
  }

  private pathFor(sendId: string): string {
    return join(this.dir, `${createHash("sha256").update(sendId).digest("hex")}.json`);
  }

  register(sendId: string, conversationId: string, text: string): McpOutboundSend {
    const path = this.pathFor(sendId);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ conversation_id: conversationId, text }))
      .digest("hex");
    const expected = {
      send_id: sendId,
      api_origin: canonicalOrigin(this.apiOrigin),
      account_identity: this.accountIdentity,
      conversation_id: conversationId,
      payload_hash: payloadHash,
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });

    let existing: McpOutboundSend | undefined;
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as McpOutboundSend;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Codex MCP send ledger is unreadable; refusing retry (${path})`);
      }
    }
    if (existing) {
      for (const [key, value] of Object.entries(expected)) {
        if ((existing as unknown as Record<string, unknown>)[key] !== value) {
          throw new Error(`send_id ${sendId} was already used for different content or account`);
        }
      }
      if (typeof existing.idempotency_key !== "string" || existing.idempotency_key.length === 0) {
        throw new Error(`Codex MCP send ledger is invalid; refusing retry (${path})`);
      }
      return existing;
    }

    const scopeHash = createHash("sha256")
      .update(`${expected.api_origin}\0${this.accountIdentity}\0${sendId}`)
      .digest("hex");
    const created: McpOutboundSend = {
      ...expected,
      idempotency_key: `relay-mcp-${scopeHash}`,
      created_at: new Date().toISOString(),
    };
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(created, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return created;
    } catch (error: any) {
      if (error?.code === "EEXIST") return this.register(sendId, conversationId, text);
      throw error;
    }
  }

  confirm(send: McpOutboundSend): void {
    if (send.confirmed_at) return;
    send.confirmed_at = new Date().toISOString();
    atomicWriteJson(this.pathFor(send.send_id), send, 0o600);
  }
}

export class SessionStore {
  private sessions: Record<string, SessionBinding>;

  constructor(private readonly home = activeRuntimeHome()) {
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

export interface CodexNotifyPolicy {
  allowed_project_roots: string[];
}

function canonicalLocalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Local, non-secret project opt-ins shared across Relay re-pairs. */
export class CodexNotifyPolicyStore {
  constructor(private readonly home = relayappHome()) {}

  get path(): string {
    return join(this.home, "codex-notify.json");
  }

  load(): CodexNotifyPolicy {
    const raw = readJson<Partial<CodexNotifyPolicy>>(this.path);
    return {
      allowed_project_roots: Array.isArray(raw?.allowed_project_roots)
        ? [...new Set(raw.allowed_project_roots.filter((entry): entry is string => typeof entry === "string").map(canonicalLocalPath))]
        : [],
    };
  }

  allowProject(projectRoot: string): string {
    const root = canonicalLocalPath(projectRoot);
    const policy = this.load();
    if (!policy.allowed_project_roots.includes(root)) policy.allowed_project_roots.push(root);
    atomicWriteJson(this.path, policy, 0o600);
    return root;
  }

  matchProject(cwd: string | undefined): string | undefined {
    if (!cwd || !isAbsolute(cwd)) return undefined;
    const candidate = canonicalLocalPath(cwd);
    return this.load().allowed_project_roots.find((root) => {
      const child = relative(root, candidate);
      return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    });
  }
}

/** One live `relayapp start` process per origin+agent runtime namespace. */
export class RuntimeLock {
  private readonly nonce = randomBytes(16).toString("hex");
  private held = false;

  constructor(private readonly runtimeHome: string) {}

  get dir(): string {
    return join(this.runtimeHome, "start.lock");
  }

  private ownerPath(dir = this.dir): string {
    return join(dir, "owner.json");
  }

  acquire(): void {
    mkdirSync(this.runtimeHome, { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        mkdirSync(this.dir, { mode: 0o700 });
        atomicWriteJson(
          this.ownerPath(),
          { pid: process.pid, nonce: this.nonce, acquired_at: new Date().toISOString() },
          0o600,
        );
        this.held = true;
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const owner = readJson<{ pid?: number; nonce?: string }>(this.ownerPath());
        const pid = owner?.pid;
        let alive = false;
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (probe: any) {
            alive = probe?.code === "EPERM";
          }
        }
        if (alive || !owner?.nonce) {
          throw new Error(
            `Another relayapp start process owns this paired agent (${this.dir}${pid ? `, pid ${pid}` : ""}).`,
          );
        }
        const stale = `${this.dir}.stale-${Date.now()}-${process.pid}-${this.nonce.slice(0, 8)}`;
        try {
          renameSync(this.dir, stale);
        } catch (renameError: any) {
          if (renameError?.code === "ENOENT") continue;
          throw new Error(`Could not recover stale Relay runtime lock ${this.dir}: ${renameError}`);
        }
      }
    }
  }

  release(): void {
    if (!this.held) return;
    const owner = readJson<{ nonce?: string }>(this.ownerPath());
    if (owner?.nonce !== this.nonce) {
      this.held = false;
      return;
    }
    try {
      unlinkSync(this.ownerPath());
      rmdirSync(this.dir);
    } catch {
      // A process exit still makes the pid-based lock recoverable.
    }
    this.held = false;
  }
}
