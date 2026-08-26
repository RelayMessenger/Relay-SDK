import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LockOwner {
  pid: number;
  nonce: string;
  account_id: string;
  created_at: string;
}

function processIsLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (
      Number.isSafeInteger(value.pid) &&
      typeof value.nonce === "string" &&
      typeof value.account_id === "string" &&
      typeof value.created_at === "string"
    ) {
      return value as LockOwner;
    }
  } catch {
    // Missing/malformed ownership is never deleted in place by a contender.
  }
  return undefined;
}

/**
 * Atomic filesystem lease preventing two OpenClaw processes on this machine
 * from running the same agent.
 *
 * Not a server constraint — Relay is happy to serve any number of pollers, and
 * every one of them receives every event. That is the problem: two processes
 * holding one agent's token both answer the same message, and the person sees
 * the reply twice.
 */
export class RelayAccountLock {
  private readonly lockPath: string;
  private readonly ownerPath: string;
  private readonly nonce = randomUUID();
  private held = false;

  constructor(
    baseUrl: string,
    agentId: string,
    private readonly accountId: string,
    baseDir = join(homedir(), ".openclaw", "relay", "consumer-locks"),
  ) {
    const key = createHash("sha256").update(`${baseUrl}\0${agentId}`).digest("hex");
    this.lockPath = join(baseDir, key);
    this.ownerPath = join(this.lockPath, "owner.json");
  }

  acquire(): void {
    mkdirSync(join(this.lockPath, ".."), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(this.lockPath, { mode: 0o700 });
        const owner: LockOwner = {
          pid: process.pid,
          nonce: this.nonce,
          account_id: this.accountId,
          created_at: new Date().toISOString(),
        };
        writeFileSync(this.ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        this.held = true;
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const owner = readOwner(this.ownerPath);
        if (!owner || processIsLive(owner.pid)) {
          const claimant = owner
            ? `account "${owner.account_id}" (pid ${owner.pid})`
            : "an existing process with unreadable ownership";
          throw new Error(`relay: this agent is already being run by ${claimant}`);
        }
        const stalePath = `${this.lockPath}.stale-${Date.now()}-${randomUUID()}`;
        try {
          renameSync(this.lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        } catch (renameError: any) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
    }
    throw new Error("relay: could not acquire the agent lock");
  }

  release(): void {
    if (!this.held) return;
    const owner = readOwner(this.ownerPath);
    if (owner?.nonce === this.nonce && existsSync(this.lockPath)) {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
    this.held = false;
  }
}
