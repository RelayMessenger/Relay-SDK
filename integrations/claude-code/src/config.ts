/**
 * Configuration, namespaced durable state, and exclusive-consumer locking.
 *
 * Credentials remain in the user-selected channel directory. Runtime state is
 * keyed by canonical API origin and Relay agent id, with routing, approvals,
 * and logical sends additionally isolated by Claude session. The consumer
 * cursor is account-scoped so sequential sessions cannot replay history.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { normalizeRelayBaseUrl } from "./relayClient.ts";
import type { PermissionBehavior, PermissionRequest } from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.relayapp.im";

export interface RelayChannelConfig {
  baseUrl: string;
  agentToken: string | null;
  ownerUserId: string | null;
  allowTofu: boolean;
  dir: string;
  /** Stable logical session key; hashed before it reaches the filesystem. */
  sessionId: string;
}

export interface StateScope {
  baseUrl: string;
  agentId: string;
  sessionId: string;
}

export interface PendingApproval {
  request: PermissionRequest;
  conversation_id: string;
  created_at: number;
  expires_at: number;
  remote_allow_enabled: boolean;
  card_sent_at?: number;
  verdict?: PermissionBehavior;
  verdict_event_id?: string;
}

export interface PendingDelivery {
  event_id: string;
  content: string;
  meta: Record<string, string>;
  conversation_id: string;
  created_at: number;
}

export interface OutboundSend {
  payload_hash: string;
  idempotency_key: string;
  created_at: number;
  confirmed_at?: number;
}

interface ConsumerState {
  cursor: number;
  owner_user_id?: string;
}

interface SessionRoutingState {
  last_conversation_id?: string;
}

export interface ChannelState extends ConsumerState, SessionRoutingState {}

interface ConsumerLedger {
  recent_event_ids: string[];
  pending_deliveries: Record<string, PendingDelivery>;
}

interface SessionLedger {
  pending_approvals: Record<string, PendingApproval>;
  outbound_sends: Record<string, OutboundSend>;
}

export const RECENT_EVENT_IDS_LIMIT = 500;
export const OUTBOUND_SENDS_LIMIT = 500;
export const PENDING_DELIVERIES_LIMIT = 1_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

export function channelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_CHANNEL_DIR ?? join(homedir(), ".claude", "channels", "relay");
}

/** Minimal .env parser: KEY=VALUE lines, optional quotes, # comments. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) values[key] = value;
  }
  return values;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayChannelConfig {
  const dir = channelDir(env);
  const envPath = join(dir, ".env");
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(readFileSync(envPath, "utf8"));
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  } catch {
    // Missing .env is a valid unconfigured state.
  }
  const pick = (key: string): string | null => {
    const fromFile = fileValues[key];
    const value = fromFile && fromFile.length > 0 ? fromFile : env[key];
    return value && value.length > 0 ? value : null;
  };
  const rawBaseUrl = pick("RELAY_BASE_URL") ?? DEFAULT_BASE_URL;
  const projectIdentity = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return {
    baseUrl: normalizeRelayBaseUrl(rawBaseUrl),
    agentToken: pick("RELAY_AGENT_TOKEN"),
    ownerUserId: pick("RELAY_OWNER_USER_ID"),
    allowTofu: pick("RELAY_ALLOW_TOFU") === "1",
    dir,
    sessionId:
      pick("RELAY_CHANNEL_SESSION_ID") ?? env.CLAUDE_SESSION_ID ?? `project:${projectIdentity}`,
  };
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeAgentId(agentId: string): string {
  const prefix = agentId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "agent";
  return `${prefix}-${hashKey(agentId).slice(0, 8)}`;
}

export function accountStateDir(rootDir: string, scope: Omit<StateScope, "sessionId">): string {
  return join(rootDir, "state", hashKey(scope.baseUrl), safeAgentId(scope.agentId));
}

export function sessionStateDir(rootDir: string, scope: StateScope): string {
  return join(accountStateDir(rootDir, scope), `session-${hashKey(scope.sessionId)}`);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on Windows/non-POSIX filesystems.
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on Windows/non-POSIX filesystems.
  }
}

function quarantineCorrupt(path: string): string {
  const quarantined = `${path}.corrupt-${Date.now()}`;
  renameSync(path, quarantined);
  return quarantined;
}

function defaultConsumerLedger(): ConsumerLedger {
  return {
    recent_event_ids: [],
    pending_deliveries: {},
  };
}

function defaultSessionLedger(): SessionLedger {
  return {
    pending_approvals: {},
    outbound_sends: {},
  };
}

/**
 * Cursor/routing corruption is recoverable because the independent ledger
 * still contains pending and recently acknowledged event ids. Ledger
 * corruption fails closed: silently discarding it could replay side effects.
 */
export class CorruptLedgerError extends Error {
  readonly quarantinedPath: string;

  constructor(path: string, quarantinedPath: string) {
    super(`durable event ledger ${path} was corrupt; quarantined at ${quarantinedPath}`);
    this.name = "CorruptLedgerError";
    this.quarantinedPath = quarantinedPath;
  }
}

export class StateStore {
  readonly accountDir: string;
  readonly dir: string;
  /** Account-scoped cursor/owner state. */
  readonly statePath: string;
  /** Account-scoped event dedupe and unacknowledged-delivery ledger. */
  readonly ledgerPath: string;
  readonly ledgerBlockedPath: string;
  readonly sessionStatePath: string;
  readonly sessionLedgerPath: string;
  readonly sessionLedgerBlockedPath: string;
  private consumerState: ConsumerState = { cursor: 0 };
  private routingState: SessionRoutingState = {};
  private consumerLedger: ConsumerLedger = defaultConsumerLedger();
  private sessionLedger: SessionLedger = defaultSessionLedger();

  constructor(rootDir: string, scope: StateScope) {
    this.accountDir = accountStateDir(rootDir, scope);
    this.dir = sessionStateDir(rootDir, scope);
    this.statePath = join(this.accountDir, "consumer-state.json");
    this.ledgerPath = join(this.accountDir, "consumer-ledger.json");
    this.ledgerBlockedPath = join(this.accountDir, "consumer-ledger.blocked");
    this.sessionStatePath = join(this.dir, "routing.json");
    this.sessionLedgerPath = join(this.dir, "session-ledger.json");
    this.sessionLedgerBlockedPath = join(this.dir, "session-ledger.blocked");
    ensurePrivateDir(this.accountDir);
    ensurePrivateDir(this.dir);
    this.loadConsumerState();
    this.loadRoutingState();
    this.throwIfBlocked(this.ledgerPath, this.ledgerBlockedPath);
    this.throwIfBlocked(this.sessionLedgerPath, this.sessionLedgerBlockedPath);
    this.loadConsumerLedger();
    this.loadSessionLedger();
    this.prune();
  }

  private throwIfBlocked(path: string, blockedPath: string): void {
    if (!existsSync(blockedPath)) return;
    let quarantined = blockedPath;
    try {
      const marker = JSON.parse(readFileSync(blockedPath, "utf8")) as {
        quarantined_path?: unknown;
      };
      if (typeof marker.quarantined_path === "string") quarantined = marker.quarantined_path;
    } catch {
      // A malformed block marker still blocks startup.
    }
    throw new CorruptLedgerError(path, quarantined);
  }

  private loadConsumerState(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<ConsumerState>;
      if (typeof parsed.cursor !== "number" || !Number.isFinite(parsed.cursor)) {
        throw new Error("invalid cursor");
      }
      this.consumerState = { ...parsed, cursor: Math.max(0, Math.floor(parsed.cursor)) };
    } catch {
      quarantineCorrupt(this.statePath);
      this.consumerState = { cursor: 0 };
    }
  }

  private loadRoutingState(): void {
    if (!existsSync(this.sessionStatePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.sessionStatePath, "utf8")) as SessionRoutingState;
      if (
        parsed.last_conversation_id !== undefined &&
        typeof parsed.last_conversation_id !== "string"
      ) {
        throw new Error("invalid routing state");
      }
      this.routingState = parsed;
    } catch {
      quarantineCorrupt(this.sessionStatePath);
      this.routingState = {};
    }
  }

  private loadConsumerLedger(): void {
    if (!existsSync(this.ledgerPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Partial<ConsumerLedger>;
      if (
        !Array.isArray(parsed.recent_event_ids) ||
        typeof parsed.pending_deliveries !== "object" ||
        parsed.pending_deliveries === null
      ) {
        throw new Error("invalid consumer ledger shape");
      }
      this.consumerLedger = parsed as ConsumerLedger;
    } catch {
      const quarantined = quarantineCorrupt(this.ledgerPath);
      writeJsonAtomic(this.ledgerBlockedPath, { quarantined_path: quarantined });
      throw new CorruptLedgerError(this.ledgerPath, quarantined);
    }
  }

  private loadSessionLedger(): void {
    if (!existsSync(this.sessionLedgerPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.sessionLedgerPath, "utf8")) as Partial<SessionLedger>;
      if (
        typeof parsed.pending_approvals !== "object" ||
        parsed.pending_approvals === null ||
        typeof parsed.outbound_sends !== "object" ||
        parsed.outbound_sends === null
      ) {
        throw new Error("invalid session ledger shape");
      }
      this.sessionLedger = parsed as SessionLedger;
    } catch {
      const quarantined = quarantineCorrupt(this.sessionLedgerPath);
      writeJsonAtomic(this.sessionLedgerBlockedPath, { quarantined_path: quarantined });
      throw new CorruptLedgerError(this.sessionLedgerPath, quarantined);
    }
  }

  get(): ChannelState {
    return { ...this.consumerState, ...this.routingState };
  }

  update(patch: Partial<ChannelState>): void {
    if (patch.cursor !== undefined || patch.owner_user_id !== undefined) {
      this.consumerState = {
        ...this.consumerState,
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.owner_user_id !== undefined ? { owner_user_id: patch.owner_user_id } : {}),
      };
      writeJsonAtomic(this.statePath, this.consumerState);
    }
    if (patch.last_conversation_id !== undefined) {
      this.routingState = {
        ...this.routingState,
        last_conversation_id: patch.last_conversation_id,
      };
      writeJsonAtomic(this.sessionStatePath, this.routingState);
    }
  }

  private saveConsumerLedger(): void {
    writeJsonAtomic(this.ledgerPath, this.consumerLedger);
  }

  private saveSessionLedger(): void {
    writeJsonAtomic(this.sessionLedgerPath, this.sessionLedger);
  }

  private prune(now = Date.now()): void {
    let dirty = false;
    for (const [id, approval] of Object.entries(this.sessionLedger.pending_approvals)) {
      if (approval.expires_at <= now) {
        delete this.sessionLedger.pending_approvals[id];
        dirty = true;
      }
    }
    const sendEntries = Object.entries(this.sessionLedger.outbound_sends);
    if (sendEntries.length > OUTBOUND_SENDS_LIMIT) {
      sendEntries
        .sort((a, b) => a[1].created_at - b[1].created_at)
        .slice(0, sendEntries.length - OUTBOUND_SENDS_LIMIT)
        .forEach(([id]) => delete this.sessionLedger.outbound_sends[id]);
      dirty = true;
    }
    if (dirty) this.saveSessionLedger();
  }

  hasSeenEvent(eventId: string): boolean {
    return (
      this.consumerLedger.recent_event_ids.includes(eventId) ||
      Object.hasOwn(this.consumerLedger.pending_deliveries, eventId) ||
      Object.values(this.sessionLedger.pending_approvals).some(
        (approval) => approval.verdict_event_id === eventId,
      )
    );
  }

  queueDelivery(delivery: PendingDelivery): boolean {
    if (this.hasSeenEvent(delivery.event_id)) return false;
    if (Object.keys(this.consumerLedger.pending_deliveries).length >= PENDING_DELIVERIES_LIMIT) {
      throw new Error(
        `pending delivery ledger reached ${PENDING_DELIVERIES_LIMIT}; acknowledge existing deliveries before polling more`,
      );
    }
    this.consumerLedger.pending_deliveries[delivery.event_id] = delivery;
    this.saveConsumerLedger();
    return true;
  }

  pendingDeliveries(): PendingDelivery[] {
    return Object.values(this.consumerLedger.pending_deliveries).sort(
      (a, b) => a.created_at - b.created_at,
    );
  }

  pendingDelivery(eventId: string): PendingDelivery | undefined {
    return this.consumerLedger.pending_deliveries[eventId];
  }

  acknowledgeDelivery(eventId: string): boolean {
    if (!Object.hasOwn(this.consumerLedger.pending_deliveries, eventId)) return false;
    delete this.consumerLedger.pending_deliveries[eventId];
    this.consumerLedger.recent_event_ids.push(eventId);
    this.consumerLedger.recent_event_ids = this.consumerLedger.recent_event_ids.slice(
      -RECENT_EVENT_IDS_LIMIT,
    );
    this.saveConsumerLedger();
    return true;
  }

  markEventSeen(eventId: string): void {
    if (!this.consumerLedger.recent_event_ids.includes(eventId)) {
      this.consumerLedger.recent_event_ids.push(eventId);
      this.consumerLedger.recent_event_ids = this.consumerLedger.recent_event_ids.slice(
        -RECENT_EVENT_IDS_LIMIT,
      );
    }
    delete this.consumerLedger.pending_deliveries[eventId];
    this.saveConsumerLedger();
  }

  registerApproval(
    request: PermissionRequest,
    conversationId: string,
    remoteAllowEnabled: boolean,
    now = Date.now(),
  ): PendingApproval {
    this.prune(now);
    const existing = this.sessionLedger.pending_approvals[request.request_id];
    if (existing) {
      const oldHash = createHash("sha256").update(JSON.stringify(existing.request)).digest("hex");
      const newHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      if (oldHash !== newHash || existing.conversation_id !== conversationId) {
        throw new Error(`permission request id ${request.request_id} was reused with different input`);
      }
      return existing;
    }
    const approval: PendingApproval = {
      request,
      conversation_id: conversationId,
      created_at: now,
      expires_at: now + DEFAULT_APPROVAL_TTL_MS,
      remote_allow_enabled: remoteAllowEnabled,
    };
    this.sessionLedger.pending_approvals[request.request_id] = approval;
    this.saveSessionLedger();
    return approval;
  }

  pendingApproval(requestId: string): PendingApproval | undefined {
    this.prune();
    return this.sessionLedger.pending_approvals[requestId];
  }

  approvalsNeedingCards(): PendingApproval[] {
    this.prune();
    return Object.values(this.sessionLedger.pending_approvals).filter(
      (approval) => !approval.card_sent_at && !approval.verdict,
    );
  }

  unresolvedVerdicts(): PendingApproval[] {
    this.prune();
    return Object.values(this.sessionLedger.pending_approvals).filter(
      (approval) => approval.verdict !== undefined,
    );
  }

  markApprovalCardSent(requestId: string, now = Date.now()): void {
    const approval = this.sessionLedger.pending_approvals[requestId];
    if (!approval) return;
    approval.card_sent_at = now;
    this.saveSessionLedger();
  }

  recordVerdict(
    requestId: string,
    behavior: PermissionBehavior,
    eventId: string,
  ): PendingApproval | null {
    const approval = this.pendingApproval(requestId);
    if (!approval || approval.verdict) return null;
    if (behavior === "allow" && !approval.remote_allow_enabled) return null;
    approval.verdict = behavior;
    approval.verdict_event_id = eventId;
    this.saveSessionLedger();
    this.consumerLedger.recent_event_ids.push(eventId);
    this.consumerLedger.recent_event_ids = this.consumerLedger.recent_event_ids.slice(
      -RECENT_EVENT_IDS_LIMIT,
    );
    this.saveConsumerLedger();
    return approval;
  }

  registerOutboundSend(
    sendId: string,
    payloadHash: string,
    idempotencyKey: string,
    now = Date.now(),
  ): OutboundSend {
    this.prune(now);
    const existing = this.sessionLedger.outbound_sends[sendId];
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new Error(`send_id ${sendId} was already used for different content`);
      }
      return existing;
    }
    const created = { payload_hash: payloadHash, idempotency_key: idempotencyKey, created_at: now };
    this.sessionLedger.outbound_sends[sendId] = created;
    this.saveSessionLedger();
    return created;
  }

  confirmOutboundSend(sendId: string, now = Date.now()): void {
    const send = this.sessionLedger.outbound_sends[sendId];
    if (!send) return;
    send.confirmed_at = now;
    this.saveSessionLedger();
  }
}

interface LockRecord {
  pid: number;
  hostname: string;
  session_id_hash: string;
  created_at: string;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ConsumerLock {
  readonly path: string;
  private held = false;

  constructor(rootDir: string, scope: StateScope) {
    const accountDir = accountStateDir(rootDir, scope);
    ensurePrivateDir(accountDir);
    this.path = join(accountDir, "consumer.lock");
    const record: LockRecord = {
      pid: process.pid,
      hostname: hostname(),
      session_id_hash: hashKey(scope.sessionId),
      created_at: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: Partial<LockRecord> = {};
        try {
          existing = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockRecord>;
        } catch {
          // Malformed lock is treated as stale and replaced below.
        }
        if (
          existing.hostname === hostname() &&
          typeof existing.pid === "number" &&
          pidIsAlive(existing.pid)
        ) {
          throw new Error(
            `Relay agent already has an active channel consumer (pid ${existing.pid}); close that Claude session before starting another`,
          );
        }
        try {
          unlinkSync(this.path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new Error("could not acquire the Relay channel consumer lock");
  }

  release(): void {
    if (!this.held) return;
    try {
      const current = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockRecord>;
      if (current.pid === process.pid) unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.held = false;
    }
  }
}
