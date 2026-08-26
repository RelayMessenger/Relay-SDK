// Minimal mock Relay API for the plugin harness proof: agent identity,
// long-poll events (one message.received, then empty), sends, typing, read.
// Logs every hit to stdout.
import http from "node:http";

const PORT = Number(process.env.MOCK_RELAY_PORT ?? 8790);
// Keyed by the client-minted message id, which is the only retry key there
// is: a repeat of one id returns the message it already committed.
const committedMessages = new Map();
let eventDelivered = false;
let cursorSeen = [];

// A model reply long enough that the 2000-char chunker must split it
// (MOCK_LLM_REPLY=short switches to a single-chunk reply).
const LONG_REPLY =
  process.env.MOCK_LLM_REPLY === "short"
    ? "Short harness reply."
    : Array.from(
        { length: 60 },
        (_, i) =>
          `Sentence ${i + 1} of the harness chunk proof, padding the reply well past one chunk.`,
      ).join(" ");

const BOOT = Date.now();
const EVENT_ID = process.env.MOCK_RELAY_EVENT_ID ?? `evt_harness_${BOOT}`;

const messageEvent = {
  event_id: EVENT_ID,
  sequence: 1,
  event_type: "message.received",
  agent_id: "agt_harness",
  conversation_id: "cnv_harness_1",
  created_at: new Date().toISOString(),
  data: {
    message: {
      id: `msg_harness_${BOOT}`,
      conversation_id: "cnv_harness_1",
      sequence: 1,
      kind: "message",
      sender: { kind: "user", id: "usr_harness" },
      is_from_me: false,
      parts: [
        {
          part_id: `prt_harness_${BOOT}`,
          part_index: 0,
          type: "text",
          text: `hello from the harness (${BOOT})`,
        },
      ],
      reply_to: null,
      fallback_text: `hello from the harness (${BOOT})`,
      status: "sent",
      created_at: new Date().toISOString(),
    },
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const auth = req.headers.authorization ?? "";
  console.log(`[mock-relay] ${req.method} ${url.pathname}${url.search}`);
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    // Mock OpenAI-compatible model backend (separate auth space).
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    const parsed = JSON.parse(body);
    console.log(`[mock-llm] completion request stream=${Boolean(parsed.stream)}`);
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      frame({
        id: "cmpl_1",
        object: "chat.completion.chunk",
        created: 0,
        model: parsed.model,
        choices: [
          { index: 0, delta: { role: "assistant", content: LONG_REPLY }, finish_reason: null },
        ],
      });
      frame({
        id: "cmpl_1",
        object: "chat.completion.chunk",
        created: 0,
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl_1",
        object: "chat.completion",
        created: 0,
        model: parsed.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: LONG_REPLY },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
      }),
    );
    return;
  }
  if (auth !== "Bearer rly_harness_token") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad token" } }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/agents/me") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        agent: {
          id: "agt_harness",
          owner_user_id: "usr_harness",
          handle: "harness",
          display_name: "Harness",
          tagline: "",
          avatar_url: null,
          visibility: "private",
          created_at: new Date().toISOString(),
        },
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/events") {
    const after = Number(url.searchParams.get("after") ?? 0);
    cursorSeen.push(after);
    if (!eventDelivered) {
      eventDelivered = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ events: [messageEvent], next_cursor: 1, latest: 1, has_more: false }),
      );
      return;
    }
    // Hold the long poll briefly, then return empty.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ events: [], next_cursor: after, latest: after, has_more: false }),
    );
    return;
  }
  const sendMatch = /^\/v2\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  if (req.method === "POST" && sendMatch) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    const parsed = JSON.parse(body);
    const replayed = committedMessages.has(parsed.message_id);
    console.log(`[mock-relay] send id=${parsed.message_id} replayed=${replayed} body=${body}`);
    if (!replayed) {
      committedMessages.set(parsed.message_id, {
        id: parsed.message_id,
        conversation_id: decodeURIComponent(sendMatch[1]),
        sequence: committedMessages.size + 2,
        kind: "message",
        sender: { kind: "agent", id: "agt_harness" },
        is_from_me: true,
        parts: (parsed.parts ?? []).map((part, index) => ({
          part_id: `prt_out_${committedMessages.size + 1}_${index}`,
          part_index: index,
          ...part,
        })),
        reply_to: parsed.reply_to ?? null,
        fallback_text: parsed.fallback_text ?? "",
        status: "sent",
        created_at: new Date().toISOString(),
      });
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: committedMessages.get(parsed.message_id) }));
    return;
  }
  if (
    req.method === "POST" &&
    /^\/v1\/conversations\/[^/]+\/(typing|read|delivered)$/.test(url.pathname)
  ) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    if (url.pathname.endsWith("/typing")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        receipt: {
          message_id: JSON.parse(body || "{}").message_id ?? "",
          conversation_id: "cnv_harness_1",
          through_sequence: 1,
          recipient: { kind: "agent", id: "agt_harness" },
          status: url.pathname.endsWith("/read") ? "read" : "delivered",
          at: new Date().toISOString(),
        },
        advanced: true,
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-relay] listening on http://127.0.0.1:${PORT}`);
});
