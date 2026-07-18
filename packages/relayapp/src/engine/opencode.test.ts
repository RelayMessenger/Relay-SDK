import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../store.js";
import type { PermissionAsk, PermissionDecision, TurnCallbacks } from "./types.js";
import { OpencodeEngine, opencodeServerFromEnv, parseServerUrl } from "./opencode.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "relayapp-opencode-test-"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  authorization?: string;
}

/** Minimal mock of the `opencode serve` HTTP surface the adapter drives. */
async function mockOpencode() {
  const requests: RecordedRequest[] = [];
  const sseClients: http.ServerResponse[] = [];
  const sessionIds: string[] = [];
  const failingPaths = new Set<string>();
  let sessionSeq = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://mock");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const entry: RecordedRequest = {
        method: req.method!,
        path: url.pathname,
        query: url.searchParams,
        body: raw ? JSON.parse(raw) : undefined,
        authorization: req.headers.authorization,
      };
      requests.push(entry);

      if (req.method === "GET" && url.pathname === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", properties: {} })}\n\n`);
        sseClients.push(res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/session") {
        sessionSeq += 1;
        const id = `ses_${sessionSeq}`;
        sessionIds.push(id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, title: entry.body?.title ?? "" }));
        return;
      }
      const getSession = /^\/session\/(ses_\d+)$/.exec(url.pathname);
      if (req.method === "GET" && getSession) {
        if (sessionIds.includes(getSession[1]!)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: getSession[1] }));
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
        return;
      }
      if (failingPaths.has(url.pathname)) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "injected failure" }));
        return;
      }
      // prompt_async, abort, permission reply, question reply/reject.
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    emit(event: { type: string; properties?: Record<string, unknown> }) {
      const frame = `data: ${JSON.stringify({ id: `evt_${Math.random()}`, ...event })}\n\n`;
      for (const client of sseClients) client.write(frame);
    },
    killStreams() {
      for (const client of sseClients) client.destroy();
      sseClients.length = 0;
    },
    failPath(path: string) {
      failingPaths.add(path);
    },
    async close() {
      this.killStreams();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function callbacks(
  onPermissionAsk?: (ask: PermissionAsk) => Promise<PermissionDecision>,
): TurnCallbacks & { asks: PermissionAsk[]; deltas: string[]; tools: string[] } {
  const asks: PermissionAsk[] = [];
  const deltas: string[] = [];
  const tools: string[] = [];
  return {
    asks,
    deltas,
    tools,
    onDelta: (text) => deltas.push(text),
    onToolEvent: (event) => tools.push(event.title ?? event.kind),
    onPermissionAsk: async (ask) => {
      asks.push(ask);
      if (onPermissionAsk) return onPermissionAsk(ask);
      return { behavior: "cancelled" };
    },
  };
}

test("parseServerUrl matches the SDK's listening-line contract", () => {
  assert.equal(
    parseServerUrl("opencode server listening on http://127.0.0.1:52341"),
    "http://127.0.0.1:52341",
  );
  assert.equal(parseServerUrl("some other log line"), undefined);
  assert.equal(parseServerUrl("opencode server listening (no url)"), undefined);
});

test("opencodeServerFromEnv resolves url + basic-auth settings", () => {
  assert.equal(opencodeServerFromEnv(undefined, {}), undefined);
  assert.deepEqual(
    opencodeServerFromEnv({ url: "http://cfg" }, { OPENCODE_SERVER_PASSWORD: "pw" }),
    { url: "http://cfg", username: undefined, password: "pw" },
  );
  assert.deepEqual(
    opencodeServerFromEnv(undefined, { OPENCODE_SERVER_URL: "http://env", OPENCODE_SERVER_USERNAME: "ops" }),
    { url: "http://env", username: "ops", password: undefined },
  );
});

test("session create + prompt_async + SSE deltas coalesce into one finalized reply", async () => {
  const mock = await mockOpencode();
  const sessions = new SessionStore(tempHome());
  const engine = new OpencodeEngine(sessions, { server: { url: mock.url } });
  try {
    const cb = callbacks();
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/tmp/proj" }, "hello", cb);
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));

    const prompt = mock.requests.find((r) => r.path === "/session/ses_1/prompt_async")!;
    assert.deepEqual(prompt.body, { parts: [{ type: "text", text: "hello" }] });
    // Directory-scoped routing on session create and prompt.
    assert.equal(mock.requests.find((r) => r.method === "POST" && r.path === "/session")!.query.get("directory"), "/tmp/proj");
    assert.equal(prompt.query.get("directory"), "/tmp/proj");

    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "txt_1", delta: "Hel" },
    });
    mock.emit({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "txt_1", delta: "lo back" },
    });
    mock.emit({
      type: "session.next.tool.called",
      properties: { sessionID: "ses_1", tool: "bash", callID: "c1", input: {} },
    });
    // text.ended is the full-value boundary and replaces the deltas.
    mock.emit({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "txt_1", text: "Hello back!" },
    });
    mock.emit({
      type: "session.next.step.ended",
      properties: { sessionID: "ses_1", finish: "stop" },
    });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });

    const result = await turn;
    assert.equal(result.text, "Hello back!");
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(cb.deltas, ["Hel", "lo back"]);
    assert.deepEqual(cb.tools, ["bash"]);

    // Binding persisted alongside the ACP scheme and reused on the next turn.
    const binding = sessions.get("cnv_a");
    assert.equal(binding?.engine, "opencode");
    assert.equal(binding?.session_id, "ses_1");

    const second = engine.startTurn({ conversationId: "cnv_a", cwd: "/tmp/proj" }, "again", callbacks());
    await waitFor(() => mock.requests.filter((r) => r.path.endsWith("/prompt_async")).length === 2);
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "txt_2", text: "second" },
    });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    assert.equal((await second).text, "second");
    // Only one session was ever created.
    assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/session").length, 1);
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("stored session binding is validated and reused across engine restarts", async () => {
  const home = tempHome();
  const mock = await mockOpencode();
  try {
    {
      const engine = new OpencodeEngine(new SessionStore(home), { server: { url: mock.url } });
      const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "hi", callbacks());
      await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
      mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
      mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_1", textID: "t", text: "ok" } });
      mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
      await turn;
      await engine.dispose();
    }
    // Fresh engine (new process): reuse requires GET /session/:id validation.
    const engine = new OpencodeEngine(new SessionStore(home), { server: { url: mock.url } });
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "again", callbacks());
    await waitFor(() => mock.requests.filter((r) => r.path.endsWith("/prompt_async")).length === 2);
    assert.ok(mock.requests.some((r) => r.method === "GET" && r.path === "/session/ses_1"));
    assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/session").length, 1);
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_1", textID: "t", text: "ok2" } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    assert.equal((await turn).text, "ok2");
    await engine.dispose();
  } finally {
    await mock.close();
  }
});

test("same conversation opened from a different repository gets a fresh session", async () => {
  const home = tempHome();
  const mock = await mockOpencode();
  const sessions = new SessionStore(home);
  const engine = new OpencodeEngine(sessions, { server: { url: mock.url } });
  try {
    const first = engine.startTurn({ conversationId: "cnv_a", cwd: "/repo/one" }, "first", callbacks());
    await waitFor(() => mock.requests.some((r) => r.path === "/session/ses_1/prompt_async"));
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_1", textID: "t", text: "one" } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    await first;

    const second = engine.startTurn({ conversationId: "cnv_a", cwd: "/repo/two" }, "second", callbacks());
    await waitFor(() => mock.requests.some((r) => r.path === "/session/ses_2/prompt_async"));
    assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/session").length, 2);
    assert.equal(sessions.get("cnv_a")?.cwd, "/repo/two");
    mock.emit({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "busy" } } });
    mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_2", textID: "t", text: "two" } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "idle" } } });
    assert.equal((await second).text, "two");
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("permission.asked round trip: Allow → reply once, Deny → reply reject", async () => {
  const mock = await mockOpencode();
  const engine = new OpencodeEngine(new SessionStore(tempHome()), { server: { url: mock.url } });
  try {
    const decisions: PermissionDecision[] = [
      { behavior: "selected", optionId: "once" },
      { behavior: "selected", optionId: "reject" },
    ];
    const cb = callbacks(async () => decisions.shift()!);
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "run it", cb);
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));

    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "per_allow1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["rm -rf build"],
        metadata: {},
        always: [],
      },
    });
    await waitFor(() => mock.requests.some((r) => r.path === "/permission/per_allow1/reply"));
    const allowReply = mock.requests.find((r) => r.path === "/permission/per_allow1/reply")!;
    assert.deepEqual(allowReply.body, { reply: "once" });

    // The ask surfaced with the binary allow/deny option shapes the broker maps.
    assert.equal(cb.asks.length, 1);
    assert.equal(cb.asks[0]!.toolName, "bash");
    assert.match(cb.asks[0]!.title!, /rm -rf build/);
    assert.deepEqual(
      cb.asks[0]!.options.map((o) => [o.optionId, o.kind]),
      [["once", "allow_once"], ["reject", "reject_once"]],
    );

    mock.emit({
      type: "permission.asked",
      properties: { id: "per_deny1", sessionID: "ses_1", permission: "edit", patterns: [], metadata: {}, always: [] },
    });
    await waitFor(() => mock.requests.some((r) => r.path === "/permission/per_deny1/reply"));
    const denyReply = mock.requests.find((r) => r.path === "/permission/per_deny1/reply")!;
    assert.equal(denyReply.body.reply, "reject");
    assert.equal(typeof denyReply.body.message, "string");

    mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_1", textID: "t", text: "done" } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    assert.equal((await turn).text, "done");
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("failed permission reply aborts and invalidates the stranded session", async () => {
  const mock = await mockOpencode();
  const sessions = new SessionStore(tempHome());
  const engine = new OpencodeEngine(sessions, { server: { url: mock.url } });
  try {
    mock.failPath("/permission/per_fail/reply");
    const turn = engine.startTurn(
      { conversationId: "cnv_a", cwd: "/w" },
      "run it",
      callbacks(async () => ({ behavior: "selected", optionId: "once" })),
    );
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({
      type: "permission.asked",
      properties: { id: "per_fail", sessionID: "ses_1", permission: "bash", patterns: ["deploy"] },
    });
    await assert.rejects(turn, /permission reply failed/);
    await waitFor(() => mock.requests.some((r) => r.path === "/session/ses_1/abort"));
    assert.equal(sessions.get("cnv_a"), undefined);
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("question.asked: single structured question becomes a card; rich ones auto-reject", async () => {
  const mock = await mockOpencode();
  const engine = new OpencodeEngine(new SessionStore(tempHome()), { server: { url: mock.url } });
  try {
    const cb = callbacks(async () => ({ behavior: "selected", optionId: "accept" }));
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "choose", cb);
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });

    mock.emit({
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "SwiftUI", description: "native" }, { label: "UIKit", description: "classic" }],
          },
        ],
      },
    });
    await waitFor(() => mock.requests.some((r) => r.path === "/question/que_1/reply"));
    assert.deepEqual(
      mock.requests.find((r) => r.path === "/question/que_1/reply")!.body,
      { answers: [["SwiftUI"]] },
    );
    assert.equal(cb.asks.length, 1);
    assert.match(cb.asks[0]!.title!, /Which framework\?/);

    // Two questions at once cannot map onto a binary card → rejected + logged.
    mock.emit({
      type: "question.asked",
      properties: {
        id: "que_2",
        sessionID: "ses_1",
        questions: [
          { question: "A?", header: "A", options: [{ label: "x", description: "" }] },
          { question: "B?", header: "B", options: [{ label: "y", description: "" }] },
        ],
      },
    });
    await waitFor(() => mock.requests.some((r) => r.path === "/question/que_2/reject"));
    assert.equal(cb.asks.length, 1, "unrepresentable question must not reach the phone");

    mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_1", textID: "t", text: "picked" } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    assert.equal((await turn).text, "picked");
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("server death mid-turn rejects the turn with a supervisor-visible error", async () => {
  const mock = await mockOpencode();
  const engine = new OpencodeEngine(new SessionStore(tempHome()), { server: { url: mock.url } });
  try {
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "hello", callbacks());
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "t", delta: "partial…" },
    });
    mock.killStreams();
    await assert.rejects(turn, /connection lost mid-turn/);
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("session.error with no text fails the turn instead of posting an empty reply", async () => {
  const mock = await mockOpencode();
  const engine = new OpencodeEngine(new SessionStore(tempHome()), { server: { url: mock.url } });
  try {
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "hello", callbacks());
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { message: "provider blew up" } },
    });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    await assert.rejects(turn, /provider blew up/);
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("attach mode sends basic auth on API calls and the event stream", async () => {
  const mock = await mockOpencode();
  const engine = new OpencodeEngine(new SessionStore(tempHome()), {
    server: { url: mock.url, username: "ops", password: "sekrit" },
  });
  try {
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "hello", callbacks());
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
    const expected = `Basic ${Buffer.from("ops:sekrit").toString("base64")}`;
    for (const request of mock.requests) {
      assert.equal(request.authorization, expected, `${request.method} ${request.path} missing auth`);
    }
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({ type: "session.next.text.ended", properties: { sessionID: "ses_1", textID: "t", text: "hi" } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    await turn;
  } finally {
    await engine.dispose();
    await mock.close();
  }
});

test("abort posts to /session/:id/abort for the bound session", async () => {
  const mock = await mockOpencode();
  const engine = new OpencodeEngine(new SessionStore(tempHome()), { server: { url: mock.url } });
  try {
    const turn = engine.startTurn({ conversationId: "cnv_a", cwd: "/w" }, "long task", callbacks());
    await waitFor(() => mock.requests.some((r) => r.path.endsWith("/prompt_async")));
    await engine.abort({ conversationId: "cnv_a", cwd: "/w" });
    assert.ok(mock.requests.some((r) => r.method === "POST" && r.path === "/session/ses_1/abort"));
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    mock.emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    await turn;
  } finally {
    await engine.dispose();
    await mock.close();
  }
});
