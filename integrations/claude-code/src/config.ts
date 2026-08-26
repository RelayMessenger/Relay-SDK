/**
 * Configuration and namespaced durable state.
 *
 * Credentials remain in the user-selected channel directory. Runtime state is
 * keyed by canonical API origin and Relay agent id, with routing, approvals,
 * and logical sends additionally isolated by Claude session. The poll cursor
 * is account-scoped so sequential sessions cannot replay history.
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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { relayMessageId } from "./ids.ts";
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
  /**
   * The id the approval card commits under, minted once at registration. A
   * retry of the card reuses it, so a prompt relayed twice is one message.
   */
  message_id: string;
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
  /** The `msg_` id this logical send committed under; a retry reuses it. */
  message_id: string;
  created_at: number;
  confirmed_at?: number;
}

interface AccountState {
  /** Last event sequence this account handled; sent back as `after`. */
  cursor: number;
  owner_user_id?: string;
}

interface SessionRoutingState {
  last_conversation_id?: string;
  /** Conversations whose owner-authenticated messages reached this session. */
  observed_conversation_ids?: string[];
}

export interface RelayChannelState extends AccountState, SessionRoutingState {}

interface EventLedger {
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
export const OBSERVED_CONVERSATIONS_LIMIT = 100;
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

function blockAndQuarantineCorrupt(path: string, blockedPath: string): string {
  const quarantined = `${path}.corrupt-${Date.now()}`;
  // Persist the fail-closed marker first. If this write fails, the corrupt
  // source remains in place and the next startup will fail on it again. If the
  // subsequent rename fails, the marker still prevents a cursor reset.
  writeJsonAtomic(blockedPath, { quarantined_path: quarantined });
  renameSync(path, quarantined);
  return quarantined;
}

function defaultEventLedger(): EventLedger {
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
 * Account cursor and ledger corruption fail closed: silently discarding either
 * could replay events whose ids have already aged out of the bounded dedupe
 * ledger. Session routing remains recoverable because it does not guard
 * external side effects.
 */
export class CorruptLedgerError extends Error {
  readonly quarantinedPath: string;

  constructor(path: string, quarantinedPath: string) {
    super(`durable state ${path} was corrupt; quarantined at ${quarantinedPath}`);
    this.name = "CorruptLedgerError";
    this.quarantinedPath = quarantinedPath;
  }
}

export class StateStore {
  readonly accountDir: string;
  readonly dir: string;
  /** Account-scoped cursor/owner state. */
  readonly statePath: string;
  readonly stateBlockedPath: string;
  /** Account-scoped event dedupe and unacknowledged-delivery ledger. */
  readonly ledgerPath: string;
  readonly ledgerBlockedPath: string;
  readonly sessionStatePath: string;
  readonly sessionLedgerPath: string;
  readonly sessionLedgerBlockedPath: string;
  private accountState: AccountState = { cursor: 0 };
  private routingState: SessionRoutingState = {};
  private eventLedger: EventLedger = defaultEventLedger();
  private sessionLedger: SessionLedger = defaultSessionLedger();

  constructor(rootDir: string, scope: StateScope) {
    this.accountDir = accountStateDir(rootDir, scope);
    this.dir = sessionStateDir(rootDir, scope);
    this.statePath = join(this.accountDir, "account-state.json");
    this.stateBlockedPath = join(this.accountDir, "account-state.blocked");
    this.ledgerPath = join(this.accountDir, "event-ledger.json");
    this.ledgerBlockedPath = join(this.accountDir, "event-ledger.blocked");
    this.sessionStatePath = join(this.dir, "routing.json");
    this.sessionLedgerPath = join(this.dir, "session-ledger.json");
    this.sessionLedgerBlockedPath = join(this.dir, "session-ledger.blocked");
    ensurePrivateDir(this.accountDir);
    ensurePrivateDir(this.dir);
    this.throwIfBlocked(this.statePath, this.stateBlockedPath);
    this.loadAccountState();
    this.loadRoutingState();
    this.throwIfBlocked(this.ledgerPath, this.ledgerBlockedPath);
    this.throwIfBlocked(this.sessionLedgerPath, this.sessionLedgerBlockedPath);
    this.loadEventLedger();
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

  private loadAccountState(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<AccountState>;
      if (
        typeof parsed.cursor !== "number" ||
        !Number.isSafeInteger(parsed.cursor) ||
        parsed.cursor < 0
      ) {
        throw new Error("invalid cursor");
      }
      if (
        parsed.owner_user_id !== undefined &&
        (typeof parsed.owner_user_id !== "string" || parsed.owner_user_id.length === 0)
      ) {
        throw new Error("invalid owner user id");
      }
      this.accountState = parsed as AccountState;
    } catch {
      const quarantined = blockAndQuarantineCorrupt(this.statePath, this.stateBlockedPath);
      throw new CorruptLedgerError(this.statePath, quarantined);
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
      if (
        parsed.observed_conversation_ids !== undefined &&
        (!Array.isArray(parsed.observed_conversation_ids) ||
          parsed.observed_conversation_ids.some(
            (conversationId) =>
              typeof conversationId !== "string" || !conversationId.startsWith("cnv_"),
          ))
      ) {
        throw new Error("invalid observed conversations");
      }
      // Migrate the pre-0.2 routing shape without weakening the outbound
      // allowlist: an old last_conversation_id was itself learned from an
      // owner-authenticated inbound delivery.
      const observed = parsed.observed_conversation_ids ??
        (parsed.last_conversation_id ? [parsed.last_conversation_id] : []);
      this.routingState = {
        ...parsed,
        observed_conversation_ids: [...new Set(observed)].slice(-OBSERVED_CONVERSATIONS_LIMIT),
      };
    } catch {
      quarantineCorrupt(this.sessionStatePath);
      this.routingState = {};
    }
  }

  private loadEventLedger(): void {
    if (!existsSync(this.ledgerPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Partial<EventLedger>;
      if (
        !Array.isArray(parsed.recent_event_ids) ||
        typeof parsed.pending_deliveries !== "object" ||
        parsed.pending_deliveries === null
      ) {
        throw new Error("invalid event ledger shape");
      }
      this.eventLedger = parsed as EventLedger;
    } catch {
      const quarantined = blockAndQuarantineCorrupt(this.ledgerPath, this.ledgerBlockedPath);
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
      const ledger = parsed as SessionLedger;
      // An approval written before message ids existed has no id to commit its
      // card under. Dropping it costs one prompt, which then waits at the local
      // terminal; keeping it would POST a body Relay rejects.
      for (const [id, approval] of Object.entries(ledger.pending_approvals)) {
        if (typeof approval.message_id !== "string" || approval.message_id.length === 0) {
          delete ledger.pending_approvals[id];
        }
      }
      this.sessionLedger = ledger;
    } catch {
      const quarantined = blockAndQuarantineCorrupt(
        this.sessionLedgerPath,
        this.sessionLedgerBlockedPath,
      );
      throw new CorruptLedgerError(this.sessionLedgerPath, quarantined);
    }
  }

  get(): RelayChannelState {
    return {
      ...this.accountState,
      ...this.routingState,
      observed_conversation_ids: [...(this.routingState.observed_conversation_ids ?? [])],
    };
  }

  update(patch: Partial<RelayChannelState>): void {
    if (patch.cursor !== undefined || patch.owner_user_id !== undefined) {
      this.accountState = {
        ...this.accountState,
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.owner_user_id !== undefined ? { owner_user_id: patch.owner_user_id } : {}),
      };
      writeJsonAtomic(this.statePath, this.accountState);
    }
    if (patch.last_conversation_id !== undefined) {
      this.recordConversation(patch.last_conversation_id);
    }
  }

  /** Record only after the sender gate accepted a real inbound Relay event. */
  recordConversation(conversationId: string): void {
    if (!conversationId.startsWith("cnv_")) {
      throw new Error("conversation id must start with cnv_");
    }
    const observed = (this.routingState.observed_conversation_ids ?? []).filter(
      (id) => id !== conversationId,
    );
    observed.push(conversationId);
    this.routingState = {
      last_conversation_id: conversationId,
      observed_conversation_ids: observed.slice(-OBSERVED_CONVERSATIONS_LIMIT),
    };
    writeJsonAtomic(this.sessionStatePath, this.routingState);
  }

  hasObservedConversation(conversationId: string): boolean {
    return (this.routingState.observed_conversation_ids ?? []).includes(conversationId);
  }

  /**
   * Bind a permission notification to its only safe active destination.
   * Claude's channel permission payload has no chat id. A pending delivery is
   * the strongest available causal link; if multiple conversations are
   * pending, fail closed instead of sending an approval card to the wrong chat.
   */
  permissionConversationId(): string | undefined {
    const pending = new Set(
      Object.values(this.eventLedger.pending_deliveries).map(
        (delivery) => delivery.conversation_id,
      ),
    );
    if (pending.size === 1) return pending.values().next().value;
    if (pending.size > 1) return undefined;
    const observed = this.routingState.observed_conversation_ids ?? [];
    return observed.length === 1 ? observed[0] : undefined;
  }

  private saveEventLedger(): void {
    writeJsonAtomic(this.ledgerPath, this.eventLedger);
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
      this.eventLedger.recent_event_ids.includes(eventId) ||
      Object.hasOwn(this.eventLedger.pending_deliveries, eventId) ||
      Object.values(this.sessionLedger.pending_approvals).some(
        (approval) => approval.verdict_event_id === eventId,
      )
    );
  }

  queueDelivery(delivery: PendingDelivery): boolean {
    if (this.hasSeenEvent(delivery.event_id)) return false;
    if (Object.keys(this.eventLedger.pending_deliveries).length >= PENDING_DELIVERIES_LIMIT) {
      throw new Error(
        `pending delivery ledger reached ${PENDING_DELIVERIES_LIMIT}; acknowledge existing deliveries before polling more`,
      );
    }
    this.eventLedger.pending_deliveries[delivery.event_id] = delivery;
    this.saveEventLedger();
    return true;
  }

  pendingDeliveries(): PendingDelivery[] {
    return Object.values(this.eventLedger.pending_deliveries).sort(
      (a, b) => a.created_at - b.created_at,
    );
  }

  pendingDelivery(eventId: string): PendingDelivery | undefined {
    return this.eventLedger.pending_deliveries[eventId];
  }

  acknowledgeDelivery(eventId: string): boolean {
    if (!Object.hasOwn(this.eventLedger.pending_deliveries, eventId)) return false;
    delete this.eventLedger.pending_deliveries[eventId];
    this.eventLedger.recent_event_ids.push(eventId);
    this.eventLedger.recent_event_ids = this.eventLedger.recent_event_ids.slice(
      -RECENT_EVENT_IDS_LIMIT,
    );
    this.saveEventLedger();
    return true;
  }

  markEventSeen(eventId: string): void {
    if (!this.eventLedger.recent_event_ids.includes(eventId)) {
      this.eventLedger.recent_event_ids.push(eventId);
      this.eventLedger.recent_event_ids = this.eventLedger.recent_event_ids.slice(
        -RECENT_EVENT_IDS_LIMIT,
      );
    }
    delete this.eventLedger.pending_deliveries[eventId];
    this.saveEventLedger();
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
      message_id: relayMessageId(now),
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
    this.eventLedger.recent_event_ids.push(eventId);
    this.eventLedger.recent_event_ids = this.eventLedger.recent_event_ids.slice(
      -RECENT_EVENT_IDS_LIMIT,
    );
    this.saveEventLedger();
    return approval;
  }

  /**
   * Bind a logical send to one payload and one `msg_` id. A retry under the
   * same send_id gets the id the first attempt used, which is what makes the
   * retry a replay rather than a second message.
   */
  registerOutboundSend(sendId: string, payloadHash: string, now = Date.now()): OutboundSend {
    this.prune(now);
    const existing = this.sessionLedger.outbound_sends[sendId];
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new Error(`send_id ${sendId} was already used for different content`);
      }
      return existing;
    }
    const created = {
      payload_hash: payloadHash,
      message_id: relayMessageId(now),
      created_at: now,
    };
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
