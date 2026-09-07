import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_BASE_URL = "https://api.relayapp.im";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const USER_CONFIG_PLACEHOLDER = /^\$\{user_config\.[A-Za-z_][A-Za-z0-9_]*\}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AllowedSenders {
  readonly ids: ReadonlySet<string>;
  readonly handles: ReadonlySet<string>;
  readonly configured: readonly string[];
}

export interface RelayChannelConfig {
  readonly agentToken: string;
  readonly baseURL: string;
  readonly allowedSenders: AllowedSenders;
  readonly channelDir: string;
  readonly stateDir: string;
  readonly accountKey: string;
  readonly sessionKey: string;
  readonly notificationRetryMs: number;
}

function actualValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || USER_CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

export function normalizeRelayBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RELAY_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new Error("RELAY_BASE_URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("RELAY_BASE_URL must be an origin without a path, query, or fragment");
  }
  const loopbackHTTP = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHTTP) {
    throw new Error("RELAY_BASE_URL must use HTTPS (HTTP is allowed only for loopback tests)");
  }
  return url.origin;
}

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const original of contents.split(/\r?\n/u)) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function parseAllowedSenders(value: string): AllowedSenders {
  const configured = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (configured.length === 0) {
    throw new Error("RELAY_ALLOWED_SENDERS must contain at least one Relay user UUID or exact Handle");
  }
  if (configured.length > 64) {
    throw new Error("RELAY_ALLOWED_SENDERS accepts at most 64 entries");
  }
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const sender of configured) {
    if (sender.length > 255 || /[\u0000-\u001f\u007f]/u.test(sender)) {
      throw new Error("RELAY_ALLOWED_SENDERS contains an invalid entry");
    }
    if (UUID_PATTERN.test(sender)) ids.add(sender.toLowerCase());
    else handles.add(sender);
  }
  return { ids, handles, configured };
}

export function senderIsAllowed(
  allowed: AllowedSenders,
  sender: { id: string; handle: string; kind: string },
): boolean {
  return sender.kind === "user"
    && (allowed.ids.has(sender.id.toLowerCase()) || allowed.handles.has(sender.handle));
}

export function defaultChannelDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = actualValue(env.RELAY_CHANNEL_DIR);
  if (configured) return resolve(configured);
  const claudeRoot = actualValue(env.CLAUDE_CONFIG_DIR) ?? join(homedir(), ".claude");
  return join(claudeRoot, "channels", "relay");
}

function loadFileEnvironment(dir: string): Record<string, string> {
  const path = join(dir, ".env");
  try {
    chmodSync(path, 0o600);
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayChannelConfig {
  const channelDir = defaultChannelDir(env);
  mkdirSync(channelDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(channelDir, 0o700);
  } catch {
    // POSIX modes are best effort on Windows.
  }
  const file = loadFileEnvironment(channelDir);
  const value = (name: string): string | undefined => actualValue(env[name]) ?? actualValue(file[name]);
  const agentToken = value("RELAY_AGENT_TOKEN") ?? "";
  if (!agentToken) throw new Error(`RELAY_AGENT_TOKEN is not configured (see ${join(channelDir, ".env")})`);
  if (agentToken.length > 4096 || /[\r\n\u0000]/u.test(agentToken)) {
    throw new Error("RELAY_AGENT_TOKEN has an invalid format");
  }
  const baseURL = normalizeRelayBaseURL(value("RELAY_BASE_URL") ?? DEFAULT_BASE_URL);
  const allowedSenders = parseAllowedSenders(value("RELAY_ALLOWED_SENDERS") ?? "");
  const accountKey = createHash("sha256")
    .update(`${baseURL}\0${agentToken}`)
    .digest("hex");
  const sessionSource = value("RELAY_CHANNEL_SESSION_ID") ?? resolve(env.PWD ?? process.cwd());
  const sessionKey = createHash("sha256").update(sessionSource).digest("hex");
  const stateDir = join(channelDir, "state", `account-${accountKey.slice(0, 24)}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(stateDir, 0o700);
  } catch {
    // POSIX modes are best effort on Windows.
  }
  return {
    agentToken,
    baseURL,
    allowedSenders,
    channelDir,
    stateDir,
    accountKey,
    sessionKey,
    notificationRetryMs: positiveInteger(
      value("RELAY_NOTIFICATION_RETRY_MS"),
      30_000,
      "RELAY_NOTIFICATION_RETRY_MS",
    ),
  };
}

interface LockRecord {
  readonly pid: number;
  readonly hostname: string;
  readonly created_at: string;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ConsumerLock {
  readonly path: string;
  #held = false;

  constructor(stateDir: string) {
    this.path = join(stateDir, "consumer.lock");
    const record: LockRecord = {
      pid: process.pid,
      hostname: hostname(),
      created_at: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        } finally {
          closeSync(fd);
        }
        this.#held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: Partial<LockRecord>;
        try {
          existing = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockRecord>;
        } catch (cause) {
          throw new Error(
            `Relay consumer lock is unreadable; confirm no channel is active before removing ${this.path}`,
            { cause },
          );
        }
        if (existing.hostname !== hostname()) {
          throw new Error(
            `Relay consumer lock belongs to host ${existing.hostname ?? "unknown"}; refusing to steal it`,
          );
        }
        if (
          typeof existing.pid === "number"
          && pidIsAlive(existing.pid)
        ) {
          throw new Error(
            `this Relay Agent already has an active local channel consumer (pid ${existing.pid})`,
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
    if (!this.#held) return;
    try {
      const current = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockRecord>;
      if (current.pid === process.pid) unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.#held = false;
    }
  }
}
