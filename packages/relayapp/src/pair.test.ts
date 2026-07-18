import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelayClient } from "./api.js";
import { ownerUserIdFromMe, pair } from "./pair.js";
import { ConfigStore } from "./store.js";

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
}

function mockServer(options: MockOptions = {}) {
  const requests: Array<{ method: string; url: string; auth?: string }> = [];
  let polls = 0;
  let remaining500 = options.failPollsWith500 ?? 0;
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

test("pair: QR + code, long-poll until claimed, token + pinned owner stored chmod 600", async () => {
  const { server, requests, pollCount } = mockServer({ pendingPolls: 1 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relayapp-pair-"));
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

    // Token + owner durably stored, mode 600.
    const stored = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(stored.agent_token, "rly_agent_token_abc");
    assert.equal(stored.owner_user_id, "usr_owner_1");
    assert.equal(stored.api_origin, origin);
    assert.equal(statSync(config.path).mode & 0o777, 0o600);
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

test("pair (L3): transient poll failures retry until the claim lands", async () => {
  const { server } = mockServer({ failPollsWith500: 2, pendingPolls: 0 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relayapp-pair-"));
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
  const home = mkdtempSync(join(tmpdir(), "relayapp-pair-"));
  const hadEnv = process.env.RELAY_OWNER_USER_ID;
  delete process.env.RELAY_OWNER_USER_ID;
  try {
    await assert.rejects(() => runPair(port, home), /RELAY_OWNER_USER_ID/);
    // The exactly-once token was not lost to the failure.
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(stored.agent_token, "rly_agent_token_abc");
    assert.equal(stored.owner_user_id, undefined);
  } finally {
    if (hadEnv !== undefined) process.env.RELAY_OWNER_USER_ID = hadEnv;
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
  const home = mkdtempSync(join(tmpdir(), "relayapp-pair-"));
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
