/**
 * Configuration and durable state for the Relay channel.
 *
 * Credentials live in ~/.claude/channels/relay/.env (RELAY_AGENT_TOKEN,
 * RELAY_BASE_URL, optional RELAY_OWNER_USER_ID); the long-poll cursor and
 * learned routing state persist in state.json alongside. RELAY_CHANNEL_DIR
 * overrides the directory (used by tests).
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.relayapp.im";

export interface RelayChannelConfig {
  baseUrl: string;
  agentToken: string | null;
  /** Explicit owner pin from .env. */
  ownerUserId: string | null;
  /**
   * Explicit opt-in (RELAY_ALLOW_TOFU=1) to trust-on-first-use owner pinning.
   * Without it, owner resolution fails closed when no pin is available.
   */
  allowTofu: boolean;
  dir: string;
}

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
      // Enforce the documented owner-only mode on the credentials file.
      chmodSync(envPath, 0o600);
    } catch {
      // Best effort (e.g. filesystems without POSIX modes).
    }
  } catch {
    // Missing .env is a valid (unconfigured) state; /relay:configure creates it.
  }
  const pick = (key: string): string | null => {
    // An empty value in .env is "unset", not an override of the process env.
    const fromFile = fileValues[key];
    const value = fromFile && fromFile.length > 0 ? fromFile : env[key];
    return value && value.length > 0 ? value : null;
  };
  return {
    baseUrl: (pick("RELAY_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    agentToken: pick("RELAY_AGENT_TOKEN"),
    ownerUserId: pick("RELAY_OWNER_USER_ID"),
    allowTofu: pick("RELAY_ALLOW_TOFU") === "1",
    dir,
  };
}

export interface ChannelState {
  /** Last acknowledged agent_sequence; poll resumes at cursor+1. */
  cursor: number;
  /** TOFU-pinned owner user id (only honored when RELAY_ALLOW_TOFU=1). */
  owner_user_id?: string;
  /** Conversation permission prompts are relayed to (last inbound wins). */
  last_conversation_id?: string;
  /**
   * Recently handled event ids (bounded FIFO). Guards against replaying the
   * whole event log into Claude's context after a cursor reset or a corrupt
   * state file.
   */
  recent_event_ids?: string[];
}

export const RECENT_EVENT_IDS_LIMIT = 500;

export class StateStore {
  private readonly path: string;
  private state: ChannelState;

  constructor(dir: string) {
    this.path = join(dir, "state.json");
    this.state = { cursor: 0 };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as ChannelState;
      if (typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor)) {
        this.state = { ...parsed, cursor: Math.max(0, Math.floor(parsed.cursor)) };
      }
    } catch {
      // First run or corrupt file: start from cursor 0 (server retention
      // bounds replay; message handling is idempotent notifications).
    }
  }

  get(): ChannelState {
    return this.state;
  }

  update(patch: Partial<ChannelState>): void {
    this.state = { ...this.state, ...patch };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }

  hasSeenEvent(eventId: string): boolean {
    return this.state.recent_event_ids?.includes(eventId) ?? false;
  }

  /** Records a handled event id in the bounded dedupe list and persists. */
  markEventSeen(eventId: string, extra?: Partial<ChannelState>): void {
    const ids = [...(this.state.recent_event_ids ?? []), eventId];
    this.update({
      ...extra,
      recent_event_ids: ids.slice(Math.max(0, ids.length - RECENT_EVENT_IDS_LIMIT)),
    });
  }
}
