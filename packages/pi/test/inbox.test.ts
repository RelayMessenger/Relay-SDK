import { afterEach, beforeEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { ChannelInbox } from "../src/inbox.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "relay-pi-inbox-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const event = (id: string) => ({ event_id: id, agent_id: "agent" }) as RelayWebhookEvent;

it("commits replay order, reply grouping and completed-event dedup across reopening", () => {
  let inbox = new ChannelInbox(directory, "https://relay.test", "agent");
  try {
    expect(inbox.accept(event("one"))).toBe(true);
    expect(inbox.accept(event("two"))).toBe(true);
    expect(inbox.accept(event("three"))).toBe(true);
    expect(inbox.accept(event("one"))).toBe(false);
    inbox.prepareReply("one", "Both.", ["one", "two"]);
    inbox.close();
    inbox = new ChannelInbox(directory, "https://relay.test", "agent");
    expect(inbox.pending().map((entry) => entry.event_id)).toEqual(["one", "three"]);
    expect(inbox.answer("one")).toBe("Both.");
    inbox.complete("one");
    inbox.close();
    inbox = new ChannelInbox(directory, "https://relay.test", "agent");
    expect(inbox.pending().map((entry) => entry.event_id)).toEqual(["three"]);
    expect(inbox.accept(event("two"))).toBe(false);
  } finally { inbox.close(); }
});

it("isolates the same event id by account and API origin", () => {
  for (const [origin, agent] of [["https://relay.test", "one"], ["https://relay.test", "two"], ["https://staging.test", "one"]]) {
    const inbox = new ChannelInbox(directory, origin!, agent!);
    try { expect(inbox.accept(event("same"))).toBe(true); } finally { inbox.close(); }
  }
});

it("rejects a concurrent writer and recovers committed events after its owner is killed", async () => {
  const source = new URL("../src/inbox.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { ChannelInbox } from ${JSON.stringify(source)};
    const inbox = new ChannelInbox(${JSON.stringify(directory)}, "https://relay.test", "agent");
    inbox.accept({event_id: "before-crash", agent_id: "agent"});
    // Keep the owner reachable until SIGKILL, as PiChannel.run does. An empty
    // interval lets GC close its SQLite handles before the contender arrives.
    setInterval(() => { inbox.pending(); }, 1000);
    setImmediate(() => {
      global.gc();
      setImmediate(() => process.stdout.write("committed\\n"));
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [line] = await once(child.stdout!, "data");
    expect(String(line)).toBe("committed\n");
    let contender: ChannelInbox | undefined;
    try {
      expect(() => { contender = new ChannelInbox(directory, "https://relay.test", "agent"); }).toThrow(/locked/);
    } finally { contender?.close(); }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recovered = new ChannelInbox(directory, "https://relay.test", "agent");
    try { expect(recovered.pending()).toEqual([event("before-crash")]); } finally { recovered.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});
