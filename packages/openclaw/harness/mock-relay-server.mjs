import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";

const port = Number(process.env.MOCK_RELAY_PORT ?? 8790);
const stateDir = process.env.OPENCLAW_STATE_DIR;
const token = "rly_harness_token";
const chatId = "00000000-0000-7000-8000-000000000010";
const eventId = "00000000-0000-7000-8000-000000000011";
const messageId = "00000000-0000-7000-8000-000000000012";
const contactId = "00000000-0000-7000-8000-000000000013";
const agentId = "00000000-0000-7000-8000-000000000014";
const sockets = new WebSocketServer({ noServer: true });
const sentMessages = new Map();
let completionCount = 0;
let sendCount = 0;
let acknowledgementCount = 0;

const inboundEvent = {
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: "message.received",
  event_id: eventId,
  created_at: new Date().toISOString(),
  trace_id: "0123456789abcdef0123456789abcdef",
  agent_id: agentId,
  data: {
    chat: { id: chatId, is_group: false },
    id: messageId,
    direction: "inbound",
    sender_handle: {
      id: contactId,
      handle: "harness",
      kind: "user",
      joined_at: new Date().toISOString(),
      display_name: "Harness",
      avatar_url: null,
      tagline: null,
      verified: false,
    },
    parts: [{ type: "text", value: "hello from Relay", reactions: null }],
    sent_at: new Date().toISOString(),
    delivered_at: null,
    read_at: null,
    reply_to: null,
  },
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function assertDurableIngress() {
  if (!stateDir) throw new Error("OPENCLAW_STATE_DIR is missing");
  const relayDir = join(stateDir, "relay");
  const databaseName = existsSync(relayDir)
    ? readdirSync(relayDir).find((name) => name.endsWith(".sqlite"))
    : undefined;
  if (!databaseName) throw new Error("Relay SQLite ingress state was not created");
  const db = new DatabaseSync(join(relayDir, databaseName), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT status FROM relay_ingress WHERE event_id = ?")
      .get(eventId);
    if (!row) throw new Error("Relay ACK arrived before durable ingress");
    return row.status;
  } finally {
    db.close();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  console.log(`[mock-relay] ${req.method} ${url.pathname}`);

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    completionCount += 1;
    const request = await body(req);
    console.log(`[mock-llm] completion request count=${completionCount}`);
    if (request?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion.chunk",
          created: 0,
          model: request.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Hello from OpenClaw." },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "cmpl-1",
          object: "chat.completion.chunk",
          created: 0,
          model: request.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    json(res, 200, {
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: request?.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from OpenClaw." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    return;
  }

  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: { message: "bad Agent Token" } });
    return;
  }
  if (
    req.method === "GET" &&
    url.pathname === "/v1/webhook-subscriptions"
  ) {
    json(res, 200, { subscriptions: [] });
    return;
  }
  if (
    (req.method === "POST" || req.method === "DELETE") &&
    url.pathname === `/v1/chats/${chatId}/typing`
  ) {
    json(res, 204);
    return;
  }
  if (
    req.method === "POST" &&
    url.pathname === `/v1/chats/${chatId}/read`
  ) {
    json(res, 204);
    return;
  }
  if (
    req.method === "POST" &&
    url.pathname === `/v1/chats/${chatId}/messages`
  ) {
    const request = await body(req);
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) {
      json(res, 400, { error: { message: "missing idempotency key" } });
      return;
    }
    const existing = sentMessages.get(key);
    const id =
      existing?.id ??
      `00000000-0000-7000-8000-${String(sentMessages.size + 20).padStart(12, "0")}`;
    if (existing && JSON.stringify(existing.body) !== JSON.stringify(request)) {
      json(res, 409, { error: { message: "idempotency conflict" } });
      return;
    }
    sentMessages.set(key, { id, body: request });
    sendCount += 1;
    console.log(
      `[mock-relay] Message send count=${sendCount} key=${key} replayed=${Boolean(existing)}`,
    );
    json(res, 200, {
      chat_id: chatId,
      message: {
        id,
        parts: (request?.message?.parts ?? []).map((part) => ({
          ...part,
          reactions: null,
        })),
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        delivery_status: "sent",
        is_system_message: false,
      },
    });
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  console.log(`[mock-relay] UPGRADE ${url.pathname}`);
  if (
    url.pathname !== "/v1/websocket" ||
    req.headers.authorization !== `Bearer ${token}`
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    sockets.emit("connection", ws, req);
  });
});

sockets.on("connection", (socket) => {
  console.log("[mock-relay] WebSocket connected");
  socket.send(
    JSON.stringify({
      type: "ready",
      connection_id: "00000000-0000-7000-8000-000000000099",
      acked_through: "0",
      full_sync_required: false,
      full_sync_through: null,
      heartbeat_interval_ms: 30_000,
      max_in_flight: 16,
    }),
  );
  socket.send(
    JSON.stringify({ type: "ping", sent_at: new Date().toISOString() }),
  );
  socket.send(
    JSON.stringify({ type: "event", sequence: "1", event: inboundEvent }),
  );
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "pong") {
      console.log("[mock-relay] JSON heartbeat pong");
      return;
    }
    if (frame.type === "ack") {
      const status = assertDurableIngress();
      acknowledgementCount += 1;
      console.log(
        `[mock-relay] cumulative ACK ${frame.through_sequence} durable=${status} count=${acknowledgementCount}`,
      );
      if (acknowledgementCount === 1) {
        socket.send(
          JSON.stringify({ type: "event", sequence: "1", event: inboundEvent }),
        );
      }
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-relay] listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.close(() => process.exit(0));
  });
}
