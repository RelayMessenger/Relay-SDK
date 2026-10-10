import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Relay, { type RelayWebhookEvent, type WebSocketLike } from "@relaymessenger/sdk";
import { PiChannel, type PiApprovals, type PiProcess } from "../src/index.js";

const uuid = (n: number): string => `01993d50-0000-7000-8000-${String(n).padStart(12, "0")}`;
const event = (n: number): RelayWebhookEvent => ({
  api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
  event_id: uuid(n), agent_id: uuid(100), trace_id: "trace", created_at: "2026-10-09T00:00:00Z",
  data: {
    id: uuid(n + 10), direction: "inbound",
    chat: { id: uuid(200), is_group: false, owner_handle: null },
    sender_handle: {
      id: uuid(300), handle: "alice", joined_at: "2026-10-09T00:00:00Z",
      kind: "user", display_name: "Alice", image_url: null, subtitle: null,
      verified: false, is_contact: true,
    },
    parts: [{ type: "text", value: `message ${n}`, reactions: null }],
  },
});

class Socket implements WebSocketLike {
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: { type: string; through_sequence?: string }[] = [];
  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string): void {
    queueMicrotask(() => { for (const listener of this.listeners.get("close") ?? []) listener({ code, reason }); });
  }
  frame(frame: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) });
  }
  get acks(): string[] { return this.sent.filter((frame) => frame.type === "ack").map((frame) => frame.through_sequence!); }
}

interface Command { id: string; type: string; message?: string }
const accepted = (id: string, data?: unknown): object => ({ type: "response", id, success: true, data });
const settled = { type: "agent_settled" };
function pi(respond: (command: Command) => object[] = () => []) {
  const commands: Command[] = [];
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (...records: object[]): void => { lines.push(...records.map((record) => JSON.stringify(record))); wake?.(); };
  async function* stdout(): AsyncGenerator<string> {
    while (!closed) {
      if (lines.length) yield lines.shift()!;
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
  }
  const process: PiProcess = {
    stdin: {
      write: (line) => { const command = JSON.parse(line) as Command; commands.push(command); push(...respond(command)); },
      end: vi.fn(),
    },
    stdout: stdout(),
    kill: vi.fn(() => { closed = true; wake?.(); }),
  };
  return { process, commands, push };
}
const answering = (text: string) => pi((command) =>
  command.type === "prompt" ? [accepted(command.id), settled]
    : command.type === "get_last_assistant_text" ? [accepted(command.id, { text })]
      : [accepted(command.id, { steering: [] })]);

let directory: string;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "relay-pi-transport-")); });
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function start(process: PiProcess, send = vi.fn().mockResolvedValue({}), approvals?: PiApprovals) {
  const relay = new Relay({ apiKey: "test-token", baseURL: "https://relay.test" });
  vi.spyOn(relay.me, "retrieve").mockResolvedValue({ id: uuid(100) } as never);
  vi.spyOn(relay.chats, "startTyping").mockResolvedValue(undefined as never);
  vi.spyOn(relay.chats, "stopTyping").mockResolvedValue(undefined as never);
  vi.spyOn(relay.chats.messages, "send").mockImplementation(send);
  const sockets: Socket[] = [];
  const errors: unknown[] = [];
  const transport = relay.websocket.run.bind(relay.websocket);
  // Only the physical socket is fake. SDK frame parsing, serialized onEvent,
  // reconnect handling and cumulative ACK generation run unchanged.
  vi.spyOn(relay.websocket, "run").mockImplementation((options) => transport({
    ...options,
    WebSocket: class extends Socket {
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.frame({
          type: "ready", connection_id: uuid(400), acked_through: "0",
          full_sync_required: false, full_sync_through: null,
          heartbeat_interval_ms: 30_000, max_in_flight: 64,
        }));
      }
    },
    minReconnectDelayMs: 1,
    maxReconnectDelayMs: 1,
    onError: (error) => { errors.push(error); },
  }));
  const controller = new AbortController();
  const spawn = vi.fn(() => process);
  const running = new PiChannel({
    agentToken: "test-token", baseURL: "https://relay.test", relay,
    inboxDirectory: directory, spawnPi: spawn,
    ...(approvals ? { approvals } : {}),
  }).run(controller.signal);
  const outcome = running.then(() => undefined, (error: unknown) => error);
  const stop = async (): Promise<void> => { controller.abort(); await outcome; };
  stops.push(stop);
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets[0]!;
  return { socket, sockets, send, spawn, errors, outcome, stop };
}

it("the serialized transport steers before settlement and waits for late steer acceptance before clearing its queue", async () => {
  const bot = pi((command) =>
    command.type === "get_last_assistant_text" ? [accepted(command.id, { text: "Together." })]
      : command.type === "clear_queue" ? [accepted(command.id, { steering: [] })] : []);
  const channel = await start(bot.process);
  channel.socket.frame({ type: "event", sequence: "1", event: event(1) });
  await vi.waitFor(() => expect(bot.commands.map((command) => command.type)).toEqual(["prompt"]));
  bot.push(accepted(bot.commands[0]!.id));
  channel.socket.frame({ type: "event", sequence: "2", event: event(2) });
  channel.socket.frame({ type: "event", sequence: "3", event: event(3) });
  await vi.waitFor(() => expect(bot.commands.map((command) => command.type)).toEqual(["prompt", "steer"]));
  expect(bot.commands[1]!.message).toContain("message 2");
  bot.push(accepted(bot.commands[1]!.id));
  await vi.waitFor(() => expect(bot.commands.map((command) => command.type)).toEqual(["prompt", "steer", "steer"]));
  expect(bot.commands[2]!.message).toContain("message 3");
  bot.push(settled);
  await vi.waitFor(() => expect(channel.socket.acks).toEqual(["1", "2", "3"]));
  // Let the settled frame's reader and its promise continuations run; ACKs
  // were already allowed by the durable inbox and are not an RPC-read fence.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(channel.send).not.toHaveBeenCalled();
  expect(bot.commands).toHaveLength(3);
  bot.push(accepted(bot.commands[2]!.id));
  await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
  expect(channel.send.mock.calls[0]![1].message).toEqual({
    parts: [{ type: "text", value: "Together." }], idempotency_key: `pi-${uuid(1)}-0`,
  });
  expect(bot.commands.map((command) => command.type)).toEqual(["prompt", "steer", "steer", "clear_queue", "get_last_assistant_text"]);
  await channel.stop();
  expect(bot.process.kill).toHaveBeenCalled();
});

it("preserves ingress order across asynchronous approval lookups without delaying durable ACKs", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const take = vi.fn(async (incoming: RelayWebhookEvent) => {
    if (incoming.event_id === uuid(1)) await gate;
    return false;
  });
  const bot = answering("Ordered.");
  const channel = await start(bot.process, vi.fn().mockResolvedValue({}), {
    take, dialog: async () => undefined,
  });
  try {
    channel.socket.frame({ type: "event", sequence: "1", event: event(1) });
    channel.socket.frame({ type: "event", sequence: "2", event: event(2) });
    await vi.waitFor(() => expect(channel.socket.acks).toEqual(["1", "2"]));
    expect(take.mock.calls.map(([incoming]) => incoming.event_id)).toEqual([uuid(1)]);
    expect(bot.commands).toEqual([]);
    release();
    await vi.waitFor(() => expect(bot.commands.filter((command) => ["prompt", "steer"].includes(command.type)).map((command) => command.message))
      .toEqual([1, 2].map((n) => `message ${n}\n\n[Relay message id: ${uuid(n + 10)}]`)));
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalled());
  } finally { release(); }
});

it("recovers an ACKed event without redelivery when shutdown interrupts Pi before acceptance, and deduplicates after restart", async () => {
  const firstBot = pi();
  const first = await start(firstBot.process);
  first.socket.frame({ type: "event", sequence: "1", event: event(1) });
  await vi.waitFor(() => expect(first.socket.acks).toEqual(["1"]));
  await vi.waitFor(() => expect(firstBot.commands).toHaveLength(1));
  await first.stop();
  expect(first.send).not.toHaveBeenCalled();
  const second = await start(answering("Recovered.").process);
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(1));
  expect(second.send.mock.calls[0]![1].message.idempotency_key).toBe(`pi-${uuid(1)}-0`);
  await second.stop();
  const third = await start(pi().process);
  third.socket.frame({ type: "event", sequence: "1", event: event(1) });
  await vi.waitFor(() => expect(third.socket.acks).toEqual(["1"]));
  expect(third.spawn).not.toHaveBeenCalled();
  expect(third.send).not.toHaveBeenCalled();
});

it("retries the persisted answer with identical parts and key after a failed send, without rerunning Pi", async () => {
  const failedSend = vi.fn().mockResolvedValueOnce({}).mockRejectedValue(new Error("reply offline"));
  const first = await start(answering("Original answer.\nhttps://example.test/item").process, failedSend);
  first.socket.frame({ type: "event", sequence: "1", event: event(1) });
  expect(await first.outcome).toEqual(expect.objectContaining({ message: "reply offline" }));
  const second = await start(answering("Must not run.").process);
  expect(second.spawn).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(2));
  expect(second.send.mock.calls).toEqual(failedSend.mock.calls);
  expect(second.spawn).not.toHaveBeenCalled();
  expect(second.send.mock.calls[0]![1].message).toEqual({
    parts: [{ type: "text", value: "Original answer." }], idempotency_key: `pi-${uuid(1)}-0`,
  });
  expect(second.send.mock.calls[1]![1].message).toEqual({
    parts: [{ type: "link", value: "https://example.test/item" }], idempotency_key: `pi-${uuid(1)}-1`,
  });
});

it("surfaces a rejected steer and recovers both accepted events in order", async () => {
  const bot = pi((command) => command.type === "steer"
    ? [{ type: "response", id: command.id, success: false, error: "steer refused" }]
    : [accepted(command.id)]);
  const first = await start(bot.process);
  first.socket.frame({ type: "event", sequence: "1", event: event(1) });
  await vi.waitFor(() => expect(bot.commands).toHaveLength(1));
  first.socket.frame({ type: "event", sequence: "2", event: event(2) });
  let failure: unknown;
  void first.outcome.then((error) => { failure = error; });
  await vi.waitFor(() => expect(failure).toEqual(expect.objectContaining({ message: "steer refused" })));
  expect(first.send).not.toHaveBeenCalled();
  const recoveryBot = answering("Recovered.");
  const second = await start(recoveryBot.process);
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(2));
  expect(recoveryBot.commands.filter((command) => command.type === "prompt").map((command) => command.message))
    .toEqual([1, 2].map((n) => `message ${n}\n\n[Relay message id: ${uuid(n + 10)}]`));
  expect(second.send.mock.calls.map(([, body]) => body.message.idempotency_key))
    .toEqual([`pi-${uuid(1)}-0`, `pi-${uuid(2)}-0`]);
});

it("keeps a leftover steer pending across shutdown after the first turn replies", async () => {
  const bot = pi((command) =>
    command.type === "prompt" && command.message?.startsWith("message 2") ? []
      : command.type === "get_last_assistant_text" ? [accepted(command.id, { text: "First." })]
        : command.type === "clear_queue" ? [accepted(command.id, { steering: ["message 2"] })]
          : [accepted(command.id)]);
  const first = await start(bot.process);
  first.socket.frame({ type: "event", sequence: "1", event: event(1) });
  await vi.waitFor(() => expect(bot.commands).toHaveLength(1));
  first.socket.frame({ type: "event", sequence: "2", event: event(2) });
  await vi.waitFor(() => expect(bot.commands.map((command) => command.type)).toEqual(["prompt", "steer"]));
  bot.push(settled);
  await vi.waitFor(() => expect(bot.commands.filter((command) => command.type === "prompt")).toHaveLength(2));
  expect(first.send).toHaveBeenCalledTimes(1);
  await first.stop();
  const resumed = answering("Second.");
  const second = await start(resumed.process);
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(1));
  expect(resumed.commands.filter((command) => command.type === "prompt").map((command) => command.message))
    .toEqual([`message 2\n\n[Relay message id: ${uuid(12)}]`]);
  expect(second.send.mock.calls[0]![1].message.idempotency_key).toBe(`pi-${uuid(2)}-0`);
});

it("does not ACK or start Pi when the actual inbox transaction fails, and retries after storage recovers", async () => {
  const channel = await start(answering("Stored.").process);
  const [account] = await readdir(directory);
  const db = new DatabaseSync(join(directory, account!, "inbox.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'disk refuses event'); END");
    channel.socket.frame({ type: "event", sequence: "1", event: event(1) });
    await vi.waitFor(() => expect(channel.errors.length).toBeGreaterThan(0));
    expect(channel.sockets.flatMap((socket) => socket.acks)).toEqual([]);
    expect(channel.spawn).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER reject_insert");
    await vi.waitFor(() => expect(channel.sockets.length).toBeGreaterThan(1));
    channel.sockets.at(-1)!.frame({ type: "event", sequence: "1", event: event(1) });
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(channel.sockets.flatMap((socket) => socket.acks)).toEqual(["1"]);
  } finally { db.close(); }
});
