import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

const ROOT = resolve(import.meta.dirname, "..");
const USER_ID = "00000000-0000-7000-8000-000000000001";
const CHAT_ID = "00000000-0000-7000-8000-000000000002";
const MESSAGE_ID = "00000000-0000-7000-8000-000000000003";
const EVENT_ID = "00000000-0000-7000-8000-000000000004";
const AGENT_ID = "00000000-0000-7000-8000-000000000005";
const CONNECTION_ID = "00000000-0000-7000-8000-000000000006";
const TOKEN = "rly_test_abcdefghijklmnop";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function inboundEvent(
  text = "ship the fix",
  eventId = EVENT_ID,
  messageId = MESSAGE_ID,
) {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: eventId,
    created_at: "2026-09-01T00:00:01.000Z",
    trace_id: "trace-protocol",
    agent_id: AGENT_ID,
    data: {
      chat: { id: CHAT_ID, is_group: false, owner_handle: null },
      id: messageId,
      idempotency_key: null,
      direction: "inbound",
      sender_handle: {
        id: USER_ID,
        handle: "@owner",
        kind: "user",
        joined_at: "2026-09-01T00:00:00.000Z",
        display_name: "Owner",
        avatar_url: null,
        tagline: null,
        verified: false,
      },
      parts: [{ type: "text", value: text, reactions: null }],
      sent_at: "2026-09-01T00:00:01.000Z",
      delivered_at: null,
      read_at: null,
      reply_to: null,
    },
  };
}

function findDatabase(channelDir: string): string {
  const state = join(channelDir, "state");
  const account = readdirSync(state).find((name) => name.startsWith("account-"));
  if (!account) throw new Error("account state directory was not created");
  return join(state, account, "channel.sqlite");
}

interface RelayMock {
  readonly baseURL: string;
  readonly readCalls: string[];
  readonly sends: Array<{ key: string | undefined; body: unknown }>;
  close(): Promise<void>;
}

async function startRelayMock(params: {
  readonly channelDir: string;
  readonly onSocket: (socket: WebSocket) => void;
  readonly onAck?: (frame: { type: string; through_sequence?: string }) => void;
  readonly onFrame?: (frame: { type: string; through_sequence?: string }) => void;
  readonly fullSyncSnapshot?: boolean;
}): Promise<RelayMock> {
  const readCalls: string[] = [];
  const sends: Array<{ key: string | undefined; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: { message: "bad token" } });
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay.test");
    if (req.method === "GET" && url.pathname === "/v1/webhook-subscriptions") {
      json(res, 200, { subscriptions: [] });
      return;
    }
    if (params.fullSyncSnapshot && req.method === "GET" && url.pathname === "/v1/chats") {
      json(res, 200, {
        chats: [{
          id: CHAT_ID,
          display_name: null,
          group_chat_icon: null,
          handles: [inboundEvent().data.sender_handle],
          is_group: false,
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T00:00:01.000Z",
        }],
        next_cursor: null,
      });
      return;
    }
    if (
      params.fullSyncSnapshot
      && req.method === "GET"
      && url.pathname === `/v1/chats/${CHAT_ID}/messages`
    ) {
      const data = inboundEvent("offline FULL sync message").data;
      json(res, 200, {
        messages: [{
          id: data.id,
          chat_id: CHAT_ID,
          from: data.sender_handle.handle,
          from_handle: data.sender_handle,
          parts: data.parts,
          reply_to: null,
          is_system_message: false,
          system_event: null,
          is_from_me: false,
          delivery_status: "delivered",
          created_at: data.sent_at,
          updated_at: data.sent_at,
          sent_at: data.sent_at,
          delivered_at: data.delivered_at,
          read_at: null,
          deliveries: [{
            contact: {
              id: AGENT_ID,
              handle: "@relay-agent",
              kind: "agent",
              joined_at: "2026-09-01T00:00:00.000Z",
              is_me: true,
              display_name: "Relay Agent",
              avatar_url: null,
              tagline: null,
              verified: false,
            },
            delivered_at: data.delivered_at,
            read_at: null,
          }],
        }],
        next_cursor: null,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === `/v1/chats/${CHAT_ID}/read`) {
      readCalls.push(url.pathname);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === `/v1/chats/${CHAT_ID}/messages`) {
      sends.push({
        key: typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
        body: await requestBody(req),
      });
      json(res, 202, {
        chat_id: CHAT_ID,
        message: {
          id: "00000000-0000-7000-8000-000000000099",
          parts: [],
          created_at: "2026-09-01T00:00:02.000Z",
          sent_at: "2026-09-01T00:00:02.000Z",
          delivery_status: "sent",
          is_system_message: false,
        },
      });
      return;
    }
    json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/websocket" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; through_sequence?: string };
      params.onFrame?.(frame);
      if (frame.type === "ack") params.onAck?.(frame);
    });
    params.onSocket(socket);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = (server.address() as AddressInfo).port;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    readCalls,
    sends,
    close: async () => {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolvePromise) => wss.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

interface MCPProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
  send(value: unknown): void;
  take(predicate: (message: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

function startMCP(channelDir: string, baseURL: string): MCPProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAY_CHANNEL_DIR: channelDir,
      RELAY_AGENT_TOKEN: TOKEN,
      RELAY_ALLOWED_SENDERS: USER_ID,
      RELAY_BASE_URL: baseURL,
      RELAY_NOTIFICATION_RETRY_MS: "60000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Record<string, unknown>[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  return {
    child,
    stderr: () => stderr,
    send(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    async take(predicate, label) {
      const started = Date.now();
      for (;;) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        if (child.exitCode !== null) {
          throw new Error(`MCP exited ${child.exitCode} waiting for ${label}\n${stderr}`);
        }
        if (Date.now() - started > 10_000) {
          throw new Error(`timed out waiting for ${label}\n${stderr}`);
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      child.stdin.end();
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP did not stop after stdin EOF\n${stderr}`)), 5_000)),
      ]);
    },
  };
}

function initialize(mcp: MCPProcess): Promise<Record<string, unknown>> {
  mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "relay-protocol-test", version: "1.0.0" },
    },
  });
  mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return mcp.take((message) => message.id === 1, "MCP initialize response");
}

describe("current Relay WebSocket and claude/channel protocol", () => {
  it("ACKs only durable ingress, marks Read at begin_processing, and sends idempotent REST replies", async () => {
    const channelDir = mkdtempSync(join(tmpdir(), "relay-protocol-"));
    cleanups.push(() => rmSync(channelDir, { recursive: true, force: true }));
    let ackResolve!: () => void;
    let ackReject!: (error: unknown) => void;
    const acked = new Promise<void>((resolvePromise, reject) => {
      ackResolve = resolvePromise;
      ackReject = reject;
    });
    const relay = await startRelayMock({
      channelDir,
      onSocket(socket) {
        socket.send(JSON.stringify({
          type: "ready",
          connection_id: CONNECTION_ID,
          acked_through: "0",
          full_sync_required: false,
          full_sync_through: null,
          heartbeat_interval_ms: 30_000,
          max_in_flight: 16,
        }));
        socket.send(JSON.stringify({ type: "event", sequence: "1", event: inboundEvent() }));
      },
      onAck(frame) {
        if (frame.through_sequence !== "1") return;
        try {
          expect(frame.through_sequence).toBe("1");
          const db = new DatabaseSync(findDatabase(channelDir), { readOnly: true });
          try {
            const checkpoint = db.prepare(
              "SELECT value FROM metadata WHERE key = 'accepted_through'",
            ).get() as { value: string };
            const row = db.prepare(
              "SELECT event_id FROM transport_events WHERE sequence = '1'",
            ).get() as { event_id: string };
            expect(checkpoint.value).toBe("1");
            expect(row.event_id).toBe(EVENT_ID);
          } finally {
            db.close();
          }
          ackResolve();
        } catch (error) {
          ackReject(error);
        }
      },
    });
    cleanups.push(() => relay.close());
    const mcp = startMCP(channelDir, relay.baseURL);
    cleanups.push(() => mcp.stop());

    const initialized = await initialize(mcp);
    const result = initialized.result as { capabilities?: { experimental?: Record<string, unknown> } };
    expect(result.capabilities?.experimental).toEqual({
      "claude/channel": {},
    });
    await acked;
    const notification = await mcp.take(
      (message) => message.method === "notifications/claude/channel",
      "Claude channel notification",
    );
    expect(notification.params).toEqual({
      content: "ship the fix",
      meta: {
        chat_id: CHAT_ID,
        message_id: MESSAGE_ID,
        sender_id: USER_ID,
        sender_handle: "@owner",
        delivery_id: EVENT_ID,
        source_sequence: "1",
        sent_at: "2026-09-01T00:00:01.000Z",
      },
    });

    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "begin_processing", arguments: { delivery_id: EVENT_ID } },
    });
    const began = await mcp.take((message) => message.id === 2, "begin_processing response");
    expect(relay.readCalls).toEqual([`/v1/chats/${CHAT_ID}/read`]);
    expect((began.result as { isError?: boolean }).isError).not.toBe(true);

    const replyCall = (id: number) => mcp.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: { chat_id: CHAT_ID, text: "done", send_id: "reply-event-1" },
      },
    });
    replyCall(3);
    await mcp.take((message) => message.id === 3, "reply response");
    expect(relay.sends).toHaveLength(1);
    expect(relay.sends[0]?.key).toMatch(/^claude-reply-[a-f0-9]{64}$/u);
    expect(relay.sends[0]?.body).toEqual({
      message: {
        parts: [{ type: "text", value: "done" }],
        idempotency_key: relay.sends[0]?.key,
      },
    });
    replyCall(4);
    const duplicate = await mcp.take((message) => message.id === 4, "idempotent retry response");
    expect(relay.sends).toHaveLength(1);
    expect(JSON.stringify(duplicate)).toContain("already sent");

    await mcp.stop();
    expect(mcp.stderr()).not.toContain(TOKEN);
  });

  it("sends full_sync_complete only after complete REST state and unread delivery commit", async () => {
    const channelDir = mkdtempSync(join(tmpdir(), "relay-full-sync-protocol-"));
    cleanups.push(() => rmSync(channelDir, { recursive: true, force: true }));
    let completedResolve!: () => void;
    let completedReject!: (error: unknown) => void;
    const completed = new Promise<void>((resolvePromise, reject) => {
      completedResolve = resolvePromise;
      completedReject = reject;
    });
    const relay = await startRelayMock({
      channelDir,
      fullSyncSnapshot: true,
      onSocket(socket) {
        socket.send(JSON.stringify({
          type: "ready",
          connection_id: CONNECTION_ID,
          acked_through: "0",
          full_sync_required: true,
          full_sync_through: "42",
          heartbeat_interval_ms: 30_000,
          max_in_flight: 16,
        }));
        socket.send(JSON.stringify({
          type: "full_sync",
          through_sequence: "42",
          reason: "checkpoint_outside_retention",
        }));
      },
      onFrame(frame) {
        if (frame.type !== "full_sync_complete") return;
        try {
          expect(frame.through_sequence).toBe("42");
          const db = new DatabaseSync(findDatabase(channelDir), { readOnly: true });
          try {
            const checkpoint = db.prepare(
              "SELECT value FROM metadata WHERE key = 'accepted_through'",
            ).get() as { value: string };
            const snapshot = db.prepare(
              "SELECT through_sequence FROM relay_snapshot WHERE singleton = 1",
            ).get() as { through_sequence: string };
            const delivery = db.prepare(
              "SELECT status FROM deliveries WHERE message_id = ?",
            ).get(MESSAGE_ID) as { status: string };
            expect(checkpoint.value).toBe("42");
            expect(snapshot.through_sequence).toBe("42");
            expect(delivery.status).toBe("pending");
          } finally {
            db.close();
          }
          completedResolve();
        } catch (error) {
          completedReject(error);
        }
      },
    });
    cleanups.push(() => relay.close());
    const mcp = startMCP(channelDir, relay.baseURL);
    cleanups.push(() => mcp.stop());
    await initialize(mcp);
    await completed;
    const notification = await mcp.take(
      (message) => message.method === "notifications/claude/channel",
      "FULL-sync reconciled channel notification",
    );
    const params = notification.params as {
      content: string;
      meta: Record<string, string>;
    };
    expect(params.content).toBe("offline FULL sync message");
    expect(params.meta).toMatchObject({
      delivery_id: `fullsync-${MESSAGE_ID}`,
      source_sequence: "42",
      full_sync: "true",
    });
    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "begin_processing",
        arguments: { delivery_id: `fullsync-${MESSAGE_ID}` },
      },
    });
    const began = await mcp.take(
      (message) => message.id === 2,
      "FULL-sync begin_processing response",
    );
    expect((began.result as { isError?: boolean }).isError).not.toBe(true);
    expect(relay.readCalls).toEqual([`/v1/chats/${CHAT_ID}/read`]);
    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "complete_processing",
        arguments: {
          delivery_id: `fullsync-${MESSAGE_ID}`,
          outcome: "failed",
        },
      },
    });
    const ended = await mcp.take(
      (message) => message.id === 3,
      "FULL-sync complete_processing response",
    );
    expect((ended.result as { isError?: boolean }).isError).not.toBe(true);
    expect(relay.sends).toHaveLength(0);
    await mcp.stop();
  });
});
