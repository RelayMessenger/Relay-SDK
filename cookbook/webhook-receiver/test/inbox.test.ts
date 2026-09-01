import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageWebhookData,
  RelayWebhookEnvelope,
} from "@relaymessenger/sdk";

import { DurableInbox } from "../src/inbox.js";
import {
  accountScope,
  relayApiOrigin,
} from "../src/config.js";
import { preparePrivateSqlitePath } from "../src/private-sqlite.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "relay-webhook-inbox-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const EVENT: RelayWebhookEnvelope<
  MessageWebhookData,
  "message.received"
> = {
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: "message.received",
  event_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  created_at: "2026-09-01T12:00:00Z",
  trace_id: "trace",
  agent_id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
  data: {
    chat: { id: "01993d50-ef7b-7b37-886b-23fd80c7ec12" },
    id: "01993d50-ef7b-7b37-886b-23fd80c7ec13",
    direction: "inbound",
    sender_handle: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec14",
      handle: "sender",
      kind: "user",
      joined_at: "2026-09-01T12:00:00Z",
      display_name: null,
      avatar_url: null,
      tagline: null,
      verified: false,
    },
    parts: [],
  },
};

describe("SQLite inbox", () => {
  it("validates the Relay origin and scopes state without storing the token", () => {
    expect(relayApiOrigin("https://api.staging.relayapp.im"))
      .toBe("https://api.staging.relayapp.im");
    expect(() => relayApiOrigin("http://example.com")).toThrow(/HTTPS/);
    const scope = accountScope("https://api.staging.relayapp.im", "secret");
    expect(scope).toMatch(/^[0-9a-f]{64}$/);
    expect(scope).not.toContain("secret");
  });

  it("deduplicates acceptance and reclaims an expired processing lease", () => {
    const inbox = new DurableInbox(":memory:", "account-a");
    expect(inbox.accept(EVENT, 100)).toBe(true);
    expect(inbox.accept(EVENT, 101)).toBe(false);

    const first = inbox.claim(200, 50);
    expect(first?.eventId).toBe(EVENT.event_id);
    expect(inbox.claim(249, 50)).toBeNull();
    expect(inbox.claim(250, 50)?.attempts).toBe(2);

    inbox.complete(EVENT.event_id);
    expect(inbox.state(EVENT.event_id)).toBe("done");
    inbox.close();
  });

  it("creates and reopens a private file for the same Relay account", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "inbox.db");
    const first = new DurableInbox(path, "account-a");
    expect(first.accept(EVENT, 100)).toBe(true);
    first.close();

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new DurableInbox(path, "account-a");
    expect(reopened.state(EVENT.event_id)).toBe("pending");
    reopened.close();
    expect(() => new DurableInbox(path, "account-b")).toThrow(
      /different account or API origin/,
    );
  });

  it("creates each missing parent component owner-only", () => {
    const directory = temporaryDirectory();
    const first = join(directory, "first");
    const second = join(first, "second");
    const path = join(second, "inbox.db");

    new DurableInbox(path, "account-a").close();

    expect(statSync(first).mode & 0o777).toBe(0o700);
    expect(statSync(second).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses an existing 0644 database without changing its mode", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "inbox.db");
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => new DurableInbox(path, "account-a")).toThrow(/0600/);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("refuses a database symlink", () => {
    const directory = temporaryDirectory();
    const target = join(directory, "target.db");
    const path = join(directory, "inbox.db");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, path);

    expect(() => new DurableInbox(path, "account-a"))
      .toThrow(/symbolic link/);
  });

  it("refuses an unsafe immediate state directory", () => {
    const directory = temporaryDirectory();
    const unsafe = join(directory, "shared");
    mkdirSync(unsafe, { mode: 0o755 });
    chmodSync(unsafe, 0o755);

    expect(() => new DurableInbox(join(unsafe, "inbox.db"), "account-a"))
      .toThrow(/directory must be owner-only/);
  });

  it("refuses a writable ancestor above a private state directory", () => {
    const directory = temporaryDirectory();
    const unsafeAncestor = join(directory, "writable");
    const privateDirectory = join(unsafeAncestor, "private");
    mkdirSync(unsafeAncestor, { mode: 0o777 });
    chmodSync(unsafeAncestor, 0o777);
    mkdirSync(privateDirectory, { mode: 0o700 });
    chmodSync(privateDirectory, 0o700);

    expect(() => new DurableInbox(
      join(privateDirectory, "inbox.db"),
      "account-a",
    )).toThrow(/ancestor directory.*writable/);
  });

  it("refuses a simulated foreign-owned 0755 ancestor", () => {
    const directory = temporaryDirectory();
    const foreignAncestor = join(directory, "foreign");
    const privateDirectory = join(foreignAncestor, "private");
    mkdirSync(foreignAncestor, { mode: 0o755 });
    chmodSync(foreignAncestor, 0o755);
    mkdirSync(privateDirectory, { mode: 0o700 });
    chmodSync(privateDirectory, 0o700);
    const actualUid = statSync(foreignAncestor).uid;
    const foreignUid = actualUid === 60_001 ? 60_002 : 60_001;
    const path = join(privateDirectory, "inbox.db");

    expect(() => preparePrivateSqlitePath(path, "Relay inbox", {
      directoryUidOverride: {
        path: foreignAncestor,
        uid: foreignUid,
      },
    })).toThrow(/owned by root or the current user/);
    expect(existsSync(path)).toBe(false);
  });

  it("does not follow a symlink substituted during directory creation", () => {
    const directory = temporaryDirectory();
    const attackerTarget = join(directory, "attacker-target");
    const racedDirectory = join(directory, "raced");
    mkdirSync(attackerTarget, { mode: 0o700 });
    chmodSync(attackerTarget, 0o700);
    const before = statSync(attackerTarget);

    expect(() => preparePrivateSqlitePath(
      join(racedDirectory, "nested", "inbox.db"),
      "Relay inbox",
      {
        raceDirectoryCreate: {
          path: racedDirectory,
          target: attackerTarget,
        },
      },
    )).toThrow(/path changed while it was being created/);

    const after = statSync(attackerTarget);
    expect(lstatSync(racedDirectory).isSymbolicLink()).toBe(true);
    expect(readdirSync(attackerTarget)).toEqual([]);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(attackerTarget, "nested"))).toBe(false);
    expect(existsSync(join(attackerTarget, "inbox.db"))).toBe(false);
  });
});
