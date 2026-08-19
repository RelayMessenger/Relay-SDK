import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelayClient } from "./api.js";
import { ownerUserIdFromMe, pair } from "./pair.js";
import {
  ApprovalStore,
  ConfigStore,
  runtimeHomeForConfig,
  SessionStore,
  StateStore,
  type RelayConfig,
} from "./store.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

interface MockOptions {
  /** Return 500 for the first N status polls (transient-failure path). */
  failPollsWith500?: number;
  /** Number of "pending" responses before "claimed". */
  pendingPolls?: number;
  /** Omit owner_user_id from /v1/agents/me. */
  omitOwner?: boolean;
  /** Return 500 for the first N authenticated profile reads. */
  failMeWith500?: number;
  /** Reject a specifically stale saved token while accepting the new claim. */
  staleToken401?: boolean;
}

function mockServer(options: MockOptions = {}) {
  const requests: Array<{ method: string; url: string; auth?: string }> = [];
  let polls = 0;
  let remaining500 = options.failPollsWith500 ?? 0;
  let remainingMe500 = options.failMeWith500 ?? 0;
  const pendingPolls = options.pendingPolls ?? 1;
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/v1/pairings") {
      return json(201, {
        pairing_id: "pair_123",
        code: "KITE-MANGO-47",
        url: "https://relayapp.im/pair/KITE-MANGO-47",
        poll_token: "rlyp_secret",
        expires_in: 600,
      });
    }
    if (req.method === "GET" && req.url === "/v1/pairings/pair_123?wait=true") {
      if (remaining500 > 0) {
        remaining500 -= 1;
        return json(500, { error: { code: "internal", message: "transient blip" } });
      }
      polls += 1;
      if (polls <= pendingPolls) return json(200, { status: "pending" });
      return json(200, {
        status: "claimed",
        agent_token: "rly_agent_token_abc",
        agent: { handle: "laptop", display_name: "Laptop" },
      });
    }
    if (req.method === "GET" && req.url === "/v1/agents/me") {
      if (options.staleToken401 && req.headers.authorization === "Bearer stale-token") {
        return json(401, { error: { code: "unauthorized", message: "revoked" } });
      }
      if (remainingMe500 > 0) {
        remainingMe500 -= 1;
        return json(500, { error: { code: "internal", message: "profile unavailable" } });
      }
      // Live wire shape: the profile is nested under `agent`.
      return json(200, {
        agent: {
          id: "agt_1",
          handle: "laptop",
          ...(options.omitOwner ? {} : { owner_user_id: "usr_owner_1" }),
        },
      });
    }
    json(404, { error: { code: "not_found", message: "nope" } });
  });
  return { server, requests, pollCount: () => polls };
}

async function runPair(port: number, home: string) {
  const origin = `http://127.0.0.1:${port}`;
  const config = new ConfigStore(home);
  const lines: string[] = [];
  const qrPayloads: string[] = [];
  await pair({
    origin,
    engine: "claude",
    deviceName: "test-box",
    config,
    client: new RelayClient(origin),
    agentClientFor: (token) => new RelayClient(origin, token),
    out: (line) => lines.push(line),
    renderQr: (url) => qrPayloads.push(url),
  });
  return { origin, config, lines, qrPayloads };
}

test("pair: QR + code, long-poll until claimed, token + pinned owner stored privately where supported", async () => {
  const { server, requests, pollCount } = mockServer({ pendingPolls: 1 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-"));
  try {
    const { origin, config, lines, qrPayloads } = await runPair(port, home);

    // QR encodes the claim url; the short code is shown beside it.
    assert.deepEqual(qrPayloads, ["https://relayapp.im/pair/KITE-MANGO-47"]);
    assert.ok(lines.some((line) => line.includes("KITE-MANGO-47")));

    // Poll long-polled with the poll_token bearer, not an agent token.
    const poll = requests.find((entry) => entry.url.startsWith("/v1/pairings/pair_123"));
    assert.equal(poll?.auth, "Bearer rlyp_secret");
    assert.ok(pollCount() >= 2, "kept polling while pending");

    // Owner pin used the delivered agent token.
    const me = requests.find((entry) => entry.url === "/v1/agents/me");
    assert.equal(me?.auth, "Bearer rly_agent_token_abc");

    // Token + owner are durably stored. POSIX platforms also expose the
    // owner-only mode bits; Windows ACLs do not map to a meaningful 0o600.
    const stored = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(stored.agent_token, "rly_agent_token_abc");
    assert.equal(stored.owner_user_id, "usr_owner_1");
    assert.equal(stored.api_origin, origin);
    if (process.platform !== "win32") {
      assert.equal(statSync(config.path).mode & 0o777, 0o600);
    }
  } finally {
    server.close();
  }
});

test("regression: owner id is parsed from the live nested { agent: { owner_user_id } } shape", () => {
  assert.equal(ownerUserIdFromMe({ agent: { owner_user_id: "usr_nested" } }), "usr_nested");
  // Tolerated legacy/flat shape.
  assert.equal(ownerUserIdFromMe({ owner_user_id: "usr_flat" }), "usr_flat");
  // Missing/empty fails closed (undefined → pair() errors with guidance).
  assert.equal(ownerUserIdFromMe({ agent: { handle: "x" } }), undefined);
  assert.equal(ownerUserIdFromMe({ agent: { owner_user_id: "" } }), undefined);
  assert.equal(ownerUserIdFromMe({}), undefined);
});

test("re-pair isolates cursor, queued work, approvals, destinations, and engine sessions", async () => {
  const { server } = mockServer({ pendingPolls: 0 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-isolation-"));
  const origin = `http://127.0.0.1:${port}`;
  const oldConfig: RelayConfig = {
    api_origin: origin,
    agent_token: "old-token",
    owner_user_id: "usr_old",
    agent: { id: "agt_old" },
  };
  const config = new ConfigStore(home);
  config.save(oldConfig);
  const oldRuntime = runtimeHomeForConfig(oldConfig, home);
  const oldState = new StateStore(oldRuntime);
  oldState.current.cursor = 999;
  oldState.current.seen_event_ids = ["evt_old"];
  oldState.current.owner_conversation_id = "cnv_old";
  oldState.current.pending_events.cnv_old = [{ event_id: "evt_old", event_type: "message.received" }];
  oldState.persist();
  new SessionStore(oldRuntime).set("cnv_old", {
    engine: "claude",
    session_id: "ses_old",
    cwd: "/old/repo",
    created_at: new Date().toISOString(),
  });
  new ApprovalStore(oldRuntime).create({
    request_id: "oldreq",
    conversation_id: "cnv_old",
    created_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    options: [{ option_id: "allow", label: "Allow" }],
    source: "acp",
  });

  try {
    await runPair(port, home);
    const nextConfig = config.load()!;
    assert.equal(nextConfig.agent?.id, "agt_1", "live agent identity must be persisted");
    const nextRuntime = runtimeHomeForConfig(nextConfig, home);
    assert.notEqual(nextRuntime, oldRuntime);
    const nextState = new StateStore(nextRuntime).current;
    assert.equal(nextState.cursor, 0);
    assert.deepEqual(nextState.seen_event_ids, []);
    assert.deepEqual(nextState.pending_events, {});
    assert.equal(nextState.owner_conversation_id, undefined);
    assert.deepEqual(new SessionStore(nextRuntime).all(), {});
    assert.deepEqual(new ApprovalStore(nextRuntime).list(), []);

    // The old account remains inspectable, but can no longer influence the
    // active config's state, destination, approvals, or sessions.
    assert.equal(new StateStore(oldRuntime).current.owner_conversation_id, "cnv_old");
    assert.equal(new SessionStore(oldRuntime).get("cnv_old")?.session_id, "ses_old");
    assert.equal(new ApprovalStore(oldRuntime).list().length, 1);
  } finally {
    server.close();
  }
});

test("pair (L3): transient poll failures retry until the claim lands", async () => {
  const { server } = mockServer({ failPollsWith500: 2, pendingPolls: 0 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-"));
  try {
    const { config } = await runPair(port, home);
    const stored = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(stored.agent_token, "rly_agent_token_abc");
  } finally {
    server.close();
  }
});

test("pair (H3): fails closed when the server reports no owner, but keeps the token", async () => {
  const { server } = mockServer({ pendingPolls: 0, omitOwner: true });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-"));
  const hadEnv = process.env.RELAY_OWNER_USER_ID;
  delete process.env.RELAY_OWNER_USER_ID;
  try {
    await assert.rejects(() => runPair(port, home), /RELAY_OWNER_USER_ID/);
    // The locally durable token was not lost to the finalization failure.
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(stored.agent_token, "rly_agent_token_abc");
    assert.equal(stored.owner_user_id, undefined);
  } finally {
    if (hadEnv !== undefined) process.env.RELAY_OWNER_USER_ID = hadEnv;
    server.close();
  }
});

test("pair resumes a saved token after transient owner lookup without creating another agent", async () => {
  const { server, requests } = mockServer({ pendingPolls: 0, failMeWith500: 1 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-resume-"));
  try {
    await assert.rejects(() => runPair(port, home), /resume owner pinning with this saved token/);
    const saved = new ConfigStore(home).load()!;
    assert.equal(saved.agent_token, "rly_agent_token_abc");
    assert.equal(saved.owner_user_id, undefined);

    const resumed = await runPair(port, home);
    assert.equal(resumed.config.load()?.owner_user_id, "usr_owner_1");
    assert.ok(resumed.lines.some((line) => line.includes("Resuming owner pinning")));
    assert.equal(
      requests.filter((request) => request.method === "POST" && request.url === "/v1/pairings").length,
      1,
      "resume must not create or overwrite with a second paired agent",
    );
  } finally {
    server.close();
  }
});

test("pair replaces a saved same-origin token rejected with 401 instead of selecting it forever", async () => {
  const { server, requests } = mockServer({ pendingPolls: 0, staleToken401: true });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-stale-"));
  const origin = `http://127.0.0.1:${port}`;
  const config = new ConfigStore(home);
  config.save({ api_origin: origin, agent_token: "stale-token" });
  try {
    const result = await runPair(port, home);
    assert.equal(result.config.load()?.agent_token, "rly_agent_token_abc");
    assert.equal(result.config.load()?.owner_user_id, "usr_owner_1");
    assert.match(result.lines.join("\n"), /rejected \(401\).*fresh pairing/);
    assert.equal(
      requests.filter((request) => request.method === "POST" && request.url === "/v1/pairings").length,
      1,
    );
  } finally {
    server.close();
  }
});

test("pair: expired pairing surfaces a clear error", async () => {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/pairings") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          pairing_id: "pair_dead",
          code: "X",
          url: "https://relayapp.im/pair/X",
          poll_token: "rlyp_x",
          expires_in: 600,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "expired" } }));
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-"));
  const origin = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(
      () =>
        pair({
          origin,
          config: new ConfigStore(home),
          client: new RelayClient(origin),
          out: () => {},
          renderQr: () => {},
        }),
      /expired/i,
    );
  } finally {
    server.close();
  }
});
