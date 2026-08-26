import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelayClient } from "./api.js";
import {
  handleFromDeviceName,
  isValidAgentHandle,
  ownerUserIdFromMe,
  pair,
  type PairOptions,
  profileCaptionForVisibility,
  profileUrlForHandle,
} from "./pair.js";
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

/** One scripted `POST /api/auth/device/token` answer. */
type TokenReply = [status: number, body: Record<string, unknown>];

const GRANTED: TokenReply = [
  200,
  { access_token: "sess_device", token_type: "Bearer", expires_in: 3600, scope: "" },
];
const PENDING: TokenReply = [400, { error: "authorization_pending" }];

interface MockOptions {
  /** Scripted token answers, in order. The last one repeats. */
  tokenReplies?: TokenReply[];
  /** Seconds the grant stays valid. */
  expiresIn?: number;
  /** Seconds between polls the server asks for. */
  interval?: number;
  /** Omit verification_uri_complete, leaving only the bare verification_uri. */
  omitCompleteUri?: boolean;
  /** Omit owner_user_id from /v1/agents/me. */
  omitOwner?: boolean;
  /** Return 500 for the first N authenticated profile reads. */
  failMeWith500?: number;
  /** Reject a specifically stale saved key while accepting the new agent. */
  staleToken401?: boolean;
  /** Omit handle from both the creation response and /v1/agents/me. */
  omitHandle?: boolean;
  /** contactAccessPolicies.visibility, as both the creation and profile reads report it. */
  visibility?: string;
  /** Fail agent creation with this status + body. */
  createAgentError?: [status: number, body: Record<string, unknown>];
}

function mockServer(options: MockOptions = {}) {
  const requests: Array<{
    method: string;
    url: string;
    auth?: string;
    contentType?: string;
    body?: any;
  }> = [];
  const replies = [...(options.tokenReplies ?? [GRANTED])];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "POST" && req.url === "/api/auth/device/code") {
        return json(200, {
          device_code: "dev_secret",
          user_code: "KITE-MANGO",
          verification_uri: "https://relayapp.im/device",
          ...(options.omitCompleteUri
            ? {}
            : { verification_uri_complete: "https://relayapp.im/device?code=KITE-MANGO" }),
          expires_in: options.expiresIn ?? 600,
          interval: options.interval ?? 5,
        });
      }
      if (req.method === "POST" && req.url === "/api/auth/device/token") {
        // Form-encoded is refused with 415, so the client must send JSON.
        if (!String(req.headers["content-type"]).includes("application/json")) {
          return json(415, { message: "unsupported media type", code: "UNSUPPORTED_MEDIA_TYPE" });
        }
        const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
        return json(reply[0], reply[1]);
      }
      if (req.method === "POST" && req.url === "/v1/me/agents") {
        if (options.createAgentError) {
          return json(options.createAgentError[0], options.createAgentError[1]);
        }
        return json(201, {
          agent: {
            id: "agt_1",
            ...(options.omitHandle ? {} : { handle: "laptop" }),
            displayName: "laptop",
            ...(options.visibility ? { visibility: options.visibility } : {}),
          },
          token: "rly_live_abc",
          chat_id: "cnv_owner",
        });
      }
      if (req.method === "GET" && req.url === "/v1/agents/me") {
        if (options.staleToken401 && req.headers.authorization === "Bearer stale-token") {
          return json(401, { error: { code: "unauthorized", message: "revoked" } });
        }
        if ((options.failMeWith500 ?? 0) > 0) {
          options.failMeWith500! -= 1;
          return json(500, { error: { code: "internal", message: "profile unavailable" } });
        }
        // Live wire shape: the profile is nested under `agent`.
        return json(200, {
          agent: {
            id: "agt_1",
            ...(options.omitHandle ? {} : { handle: "laptop" }),
            ...(options.omitOwner ? {} : { owner_user_id: "usr_owner_1" }),
            ...(options.visibility ? { visibility: options.visibility } : {}),
          },
        });
      }
      json(404, { error: { code: "not_found", message: "nope" } });
    });
  });
  return {
    server,
    requests,
    countOf: (method: string, url: string) =>
      requests.filter((entry) => entry.method === method && entry.url === url).length,
  };
}

/**
 * A clock the poll loop drives itself: sleeping advances it, so wall-clock
 * expiry and the requested interval are both observable without waiting.
 */
function fakeClock() {
  let current = 1_000_000;
  const delays: number[] = [];
  return {
    delays,
    now: () => current,
    sleep: async (ms: number) => {
      delays.push(ms);
      current += ms;
    },
    random: () => 0,
  };
}

async function runPair(port: number, home: string, overrides: Partial<PairOptions> = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const config = new ConfigStore(home);
  const lines: string[] = [];
  const qrPayloads: string[] = [];
  const clock = fakeClock();
  await pair({
    origin,
    deviceName: "laptop",
    config,
    client: new RelayClient(origin),
    agentClientFor: (token) => new RelayClient(origin, token),
    out: (line) => lines.push(line),
    renderQr: (url) => qrPayloads.push(url),
    now: clock.now,
    sleep: clock.sleep,
    random: clock.random,
    ...overrides,
  });
  return { origin, config, lines, qrPayloads, delays: clock.delays };
}

test("pair: QR + user code, poll until approved, key + pinned owner stored privately where supported", async () => {
  const { server, requests, countOf } = mockServer();
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-"));
  try {
    const { origin, config, lines, qrPayloads } = await runPair(port, home);

    // The QR encodes the complete verification url; the short user code is
    // shown beside it. Once the owner is pinned, the SAME renderQr is reused
    // for the agent's own profile — REL-301: there is no in-app QR surface,
    // so this terminal print is the only place a profile QR exists.
    assert.deepEqual(qrPayloads, [
      "https://relayapp.im/device?code=KITE-MANGO",
      "https://relayapp.im/@laptop",
    ]);
    assert.ok(lines.some((line) => line.includes("KITE-MANGO")));
    assert.ok(lines.some((line) => line.includes("https://relayapp.im/@laptop")));

    // The token request is JSON with the RFC 8628 grant type; a form-encoded
    // body would have been refused with 415.
    const poll = requests.find((entry) => entry.url === "/api/auth/device/token");
    assert.match(poll!.contentType!, /application\/json/);
    assert.equal(poll!.body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(poll!.body.device_code, "dev_secret");

    // The agent is created with the device session, and only then is the
    // agent's own key used for the profile read.
    const create = requests.find((entry) => entry.url === "/v1/me/agents");
    assert.equal(create?.auth, "Bearer sess_device");
    assert.deepEqual(create?.body, { handle: "laptop", displayName: "laptop" });
    const me = requests.find((entry) => entry.url === "/v1/agents/me");
    assert.equal(me?.auth, "Bearer rly_live_abc");
    assert.equal(countOf("POST", "/v1/me/agents"), 1);

    // Key + owner are durably stored. POSIX platforms also expose the
    // owner-only mode bits; Windows ACLs do not map to a meaningful 0o600.
    const stored = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(stored.agent_token, "rly_live_abc");
    assert.equal(stored.owner_user_id, "usr_owner_1");
    assert.equal(stored.api_origin, origin);
    assert.equal(stored.agent.handle, "laptop");
    assert.equal(stored.agent.display_name, "laptop");
    if (process.platform !== "win32") {
      assert.equal(statSync(config.path).mode & 0o777, 0o600);
    }
  } finally {
    server.close();
  }
});

test("pair: authorization_pending keeps polling at the server's interval until the grant lands", async () => {
  const { server, countOf } = mockServer({
    interval: 5,
    tokenReplies: [PENDING, PENDING, GRANTED],
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-pending-"));
  try {
    const { config, delays } = await runPair(port, home);
    assert.equal(config.load()?.agent_token, "rly_live_abc");
    // Three polls, each waiting the advertised five seconds first. Jitter is
    // seeded to zero here; that it is ADDED is the next test's subject.
    assert.deepEqual(delays, [5_000, 5_000, 5_000]);
    assert.equal(countOf("POST", "/api/auth/device/token"), 3);
  } finally {
    server.close();
  }
});

test("pair: polling waits interval + jitter, because the server times every poll it rejects", async () => {
  const { server } = mockServer({ interval: 5, tokenReplies: [PENDING, GRANTED] });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-jitter-"));
  try {
    const { delays } = await runPair(port, home, { random: () => 0.5 });
    // Arriving at exactly `interval` intermittently reads as too fast against
    // the server's lastPolledAt, so every wait carries a little slack.
    assert.deepEqual(delays, [5_500, 5_500]);
  } finally {
    server.close();
  }
});

test("pair: slow_down widens the interval by five seconds and keeps the same device code", async () => {
  const { server, requests } = mockServer({
    interval: 5,
    tokenReplies: [[400, { error: "slow_down" }], [400, { error: "slow_down" }], GRANTED],
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-slowdown-"));
  try {
    const { config, delays } = await runPair(port, home);
    assert.equal(config.load()?.agent_token, "rly_live_abc");
    assert.deepEqual(delays, [5_000, 10_000, 15_000]);
    const codes = requests
      .filter((entry) => entry.url === "/api/auth/device/token")
      .map((entry) => entry.body.device_code);
    assert.deepEqual(codes, ["dev_secret", "dev_secret", "dev_secret"], "slow_down reuses the grant");
  } finally {
    server.close();
  }
});

test("pair: access_denied stops with its own message and creates nothing", async () => {
  const { server, countOf } = mockServer({
    tokenReplies: [[400, { error: "access_denied", error_description: "user declined" }]],
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-denied-"));
  try {
    await assert.rejects(() => runPair(port, home), /declined in the Relay app/);
    assert.equal(countOf("POST", "/v1/me/agents"), 0);
    assert.equal(new ConfigStore(home).load(), undefined);
  } finally {
    server.close();
  }
});

test("pair: expired_token and wall-clock expiry both report the code expired", async () => {
  const expiredByServer = mockServer({ tokenReplies: [[400, { error: "expired_token" }]] });
  const port = await listen(expiredByServer.server);
  try {
    await assert.rejects(
      () => runPair(port, mkdtempSync(join(tmpdir(), "relaymessenger-pair-exp-"))),
      /code expired before it was approved/,
    );
  } finally {
    expiredByServer.server.close();
  }

  // Wall clock: the grant lives 12 s and the server asks for 5 s polls, so the
  // third wait crosses the deadline and the client stops on its own rather
  // than polling a code it knows is dead.
  const neverApproved = mockServer({ expiresIn: 12, interval: 5, tokenReplies: [PENDING] });
  const port2 = await listen(neverApproved.server);
  try {
    await assert.rejects(
      () => runPair(port2, mkdtempSync(join(tmpdir(), "relaymessenger-pair-wall-"))),
      /code expired before it was approved/,
    );
    assert.equal(neverApproved.countOf("POST", "/api/auth/device/token"), 2);
  } finally {
    neverApproved.server.close();
  }
});

test("pair: invalid_grant names the reason a retry cannot fix", async () => {
  const { server } = mockServer({ tokenReplies: [[400, { error: "invalid_grant" }]] });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => runPair(port, mkdtempSync(join(tmpdir(), "relaymessenger-pair-invalid-"))),
      /no longer recognises this code/,
    );
  } finally {
    server.close();
  }
});

test("pair: Better Auth's own { message, code } shape is reported, not read as an RFC 8628 state", async () => {
  const { server } = mockServer({
    tokenReplies: [[400, { message: "device_code is required", code: "INVALID_DEVICE_CODE" }]],
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => runPair(port, mkdtempSync(join(tmpdir(), "relaymessenger-pair-shape-"))),
      /device_code is required \(INVALID_DEVICE_CODE\)/,
    );
  } finally {
    server.close();
  }
});

test("pair: a 5xx on the token endpoint is transient and polling continues", async () => {
  const { server, countOf } = mockServer({
    tokenReplies: [[502, { message: "bad gateway" }], PENDING, GRANTED],
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-5xx-"));
  try {
    const { config, lines } = await runPair(port, home);
    assert.equal(config.load()?.agent_token, "rly_live_abc");
    assert.ok(lines.some((line) => line.startsWith("(retrying")));
    assert.equal(countOf("POST", "/api/auth/device/token"), 3);
  } finally {
    server.close();
  }
});

test("pair: a server without verification_uri_complete falls back to the bare verification url", async () => {
  const { server } = mockServer({ omitCompleteUri: true });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-uri-"));
  try {
    const { qrPayloads } = await runPair(port, home);
    assert.equal(qrPayloads[0], "https://relayapp.im/device");
  } finally {
    server.close();
  }
});

test("pair: a taken handle is reported before anything is stored, with the flag that fixes it", async () => {
  const { server } = mockServer({
    createAgentError: [409, { error: { code: "handle_taken", message: "@laptop is already taken" } }],
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-taken-"));
  try {
    await assert.rejects(() => runPair(port, home), /--handle <handle>/);
    assert.equal(new ConfigStore(home).load(), undefined);
  } finally {
    server.close();
  }
});

test("pair: a device name with no valid handle in it is refused before anyone is asked to approve", async () => {
  const { server, requests, countOf } = mockServer();
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-badname-"));
  try {
    await assert.rejects(
      () => runPair(port, home, { deviceName: "42" }),
      /Pass one with `relaymessenger pair --handle/,
    );
    assert.equal(countOf("POST", "/api/auth/device/code"), 0, "no code was requested");

    // An explicit handle rescues the same machine name.
    const { config } = await runPair(port, home, { deviceName: "42", handle: "shed_bot" });
    assert.equal(config.load()?.agent_token, "rly_live_abc");
    const create = requests.find((entry) => entry.url === "/v1/me/agents");
    assert.deepEqual(create?.body, { handle: "shed_bot", displayName: "42" });
  } finally {
    server.close();
  }
});

test("handles derived from a machine name obey Relay's grammar or are refused", () => {
  assert.equal(handleFromDeviceName("Morrison's MacBook Pro"), "morrison_s_macbook_pro");
  assert.equal(handleFromDeviceName("laptop"), "laptop");
  assert.equal(handleFromDeviceName("dev-box-01.local"), "dev_box_01_local");
  // Leading non-letters are dropped, not rewritten into a leading underscore.
  assert.equal(handleFromDeviceName("2020-imac"), "imac");
  // Nothing valid survives: too short, or no letter to start with.
  assert.equal(handleFromDeviceName("42"), undefined);
  assert.equal(handleFromDeviceName("--"), undefined);
  assert.equal(handleFromDeviceName("ok"), undefined);

  assert.equal(isValidAgentHandle("laptop"), true);
  assert.equal(isValidAgentHandle("a_b_c"), true);
  assert.equal(isValidAgentHandle("Laptop"), false);
  assert.equal(isValidAgentHandle("a__b"), false);
  assert.equal(isValidAgentHandle("trailing_"), false);
  assert.equal(isValidAgentHandle("1st"), false);
  assert.equal(isValidAgentHandle("ab"), false);
  assert.equal(isValidAgentHandle("a".repeat(33)), false);
});

test("REL-301: profileUrlForHandle matches Relay-iOS's Contact.profileShareURL exactly", () => {
  assert.equal(profileUrlForHandle("laptop"), "https://relayapp.im/@laptop");
  assert.equal(profileUrlForHandle("code_agent_2"), "https://relayapp.im/@code_agent_2");
});

test("REL-301: profileCaptionForVisibility matches measured server behavior, not the enum's implication", () => {
  // "public" discloses nothing the link doesn't already say by working for anyone
  // who has it — no caption, same as a field the server never sent. The caption
  // exists only to name a RESTRICTION the reader can't see from the link itself.
  assert.equal(profileCaptionForVisibility("public"), undefined);
  // "unlisted" still 200s from the anonymous GET /v1/contacts/:handle/profile
  // (Relay-Server server/src/routes/contacts.ts, no session check) — anyone
  // holding the link opens it — but it stays out of Store browse/search
  // (server/src/domain/agentCreation.ts), which isn't visible from the link,
  // so it's the one fact worth telling the owner.
  assert.equal(
    profileCaptionForVisibility("unlisted"),
    "Unlisted — anyone with the link can open this profile, but it won't turn up in search.",
  );
  // "private" 404s from that same anonymous route and the signed-in
  // counterpart at GET /v1/contacts/:handle only admits the owner
  // (`or(ne(visibility, "private"), eq(ownerUserId, user.id))`).
  assert.equal(
    profileCaptionForVisibility("private"),
    "Private — only you can open this; the link won't work for anyone else.",
  );
  // Unknown/missing visibility asserts nothing rather than guessing.
  assert.equal(profileCaptionForVisibility(undefined), undefined);
  assert.equal(profileCaptionForVisibility("some-future-enum-value"), undefined);
});

test("REL-301: the profile QR always prints regardless of visibility — caption present only for a real restriction, absent for public or a missing field", async () => {
  for (const [visibility, expectedCaption] of [
    // caption-present: a restriction the link's bare existence doesn't disclose.
    ["unlisted", "Unlisted — anyone with the link can open this profile, but it won't turn up in search."],
    ["private", "Private — only you can open this; the link won't work for anyone else."],
    // caption-absent: nothing to disclose ("public" behaves exactly as the link implies).
    ["public", undefined],
    // caption-absent: the field itself is missing from the /v1/agents/me response —
    // the caption asserts nothing about a state it never measured, exactly like the
    // missing-handle guard skips the whole block rather than printing "@undefined".
    [undefined, undefined],
  ] as const) {
    const { server } = mockServer(visibility ? { visibility } : {});
    const port = await listen(server);
    const label = visibility ?? "field-absent";
    const home = mkdtempSync(join(tmpdir(), `relaymessenger-pair-vis-${label}-`));
    try {
      const { lines, qrPayloads } = await runPair(port, home);
      // The print itself is never gated on visibility — same QR, same link, at
      // every level (team-lead ruling: the owner's own phone scanning it is
      // the primary use, which works regardless).
      assert.ok(qrPayloads.includes("https://relayapp.im/@laptop"), `${label}: QR still printed`);
      if (expectedCaption) {
        assert.ok(
          lines.some((line) => line.trim() === expectedCaption),
          `${label}: expected caption line present`,
        );
      } else {
        // Caption-absent: neither the "Public" caption text nor the em dash
        // caption format appears anywhere in the output for this run.
        assert.ok(
          !lines.some((line) => line.trim().startsWith("Public —") || line.trim().startsWith("Unlisted —") || line.trim().startsWith("Private —")),
          `${label}: no caption line printed`,
        );
      }
    } finally {
      server.close();
    }
  }
});

test("REL-301: a server that omits handle finishes without printing a profile block", async () => {
  const { server } = mockServer({ omitHandle: true });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-nohandle-"));
  try {
    const { config, lines, qrPayloads } = await runPair(port, home);

    // The key is stored — a missing handle must not read as a failure.
    assert.equal(config.load()?.agent_token, "rly_live_abc");
    assert.equal(config.load()?.owner_user_id, "usr_owner_1");

    // No profile block: only the approval QR was rendered, and no line
    // mentions a bare "@" handle.
    assert.deepEqual(qrPayloads, ["https://relayapp.im/device?code=KITE-MANGO"]);
    assert.ok(!lines.some((line) => line.startsWith("  @")));
    assert.ok(lines.some((line) => line.includes("Next: relaymessenger start")));
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

test("a new agent isolates cursor, queued work, approvals, destinations, and engine sessions", async () => {
  const { server } = mockServer();
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
    chat_id: "cnv_old",
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

test("pair (H3): fails closed when the server reports no owner, but keeps the key", async () => {
  const { server } = mockServer({ omitOwner: true });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-"));
  const hadEnv = process.env.RELAY_OWNER_USER_ID;
  delete process.env.RELAY_OWNER_USER_ID;
  try {
    await assert.rejects(() => runPair(port, home), /RELAY_OWNER_USER_ID/);
    // The locally durable key was not lost to the finalization failure.
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(stored.agent_token, "rly_live_abc");
    assert.equal(stored.owner_user_id, undefined);
  } finally {
    if (hadEnv !== undefined) process.env.RELAY_OWNER_USER_ID = hadEnv;
    server.close();
  }
});

test("pair resumes a saved key after transient owner lookup without creating another agent", async () => {
  const { server, countOf } = mockServer({ failMeWith500: 1 });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-resume-"));
  try {
    await assert.rejects(() => runPair(port, home), /resume owner pinning with this saved key/);
    const saved = new ConfigStore(home).load()!;
    assert.equal(saved.agent_token, "rly_live_abc");
    assert.equal(saved.owner_user_id, undefined);

    const resumed = await runPair(port, home);
    assert.equal(resumed.config.load()?.owner_user_id, "usr_owner_1");
    assert.ok(resumed.lines.some((line) => line.includes("Resuming owner pinning")));
    assert.equal(
      countOf("POST", "/v1/me/agents"),
      1,
      "resume must not create or overwrite with a second agent",
    );
  } finally {
    server.close();
  }
});

test("pair replaces a saved same-origin key rejected with 401 instead of selecting it forever", async () => {
  const { server, countOf } = mockServer({ staleToken401: true });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-pair-stale-"));
  const origin = `http://127.0.0.1:${port}`;
  const config = new ConfigStore(home);
  config.save({ api_origin: origin, agent_token: "stale-token" });
  try {
    const result = await runPair(port, home);
    assert.equal(result.config.load()?.agent_token, "rly_live_abc");
    assert.equal(result.config.load()?.owner_user_id, "usr_owner_1");
    assert.match(result.lines.join("\n"), /rejected \(401\).*fresh approval/);
    assert.equal(countOf("POST", "/v1/me/agents"), 1);
  } finally {
    server.close();
  }
});
