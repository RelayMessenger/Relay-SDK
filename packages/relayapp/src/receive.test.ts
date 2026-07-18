import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventsPage, RelayClient } from "./api.js";
import type { EngineAdapter, TurnCallbacks } from "./engine/types.js";
import {
  MAX_PERMISSION_PREVIEW_CHARS,
  PermissionBroker,
  buildPermissionCard,
  parseVerdictDataPart,
  parseVerdictText,
} from "./permissions.js";
import { ReceiveLoop, promptTextFromMessages, turnIdempotencyKey } from "./receive.js";
import {
  ApprovalStore,
  StateStore,
  type BridgeState,
  type PendingApproval,
  type RelayEvent,
} from "./store.js";

const OWNER = "usr_owner";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "relayapp-test-"));
}

function userMessageEvent(
  eventId: string,
  conversationId: string,
  text: string,
  sequence = 1,
  senderId = OWNER,
): RelayEvent {
  return {
    event_id: eventId,
    event_type: "message.received",
    created_at: new Date().toISOString(),
    data: {
      message: {
        id: `msg_${eventId}`,
        conversation_id: conversationId,
        sequence,
        sender: { kind: "user", id: senderId },
        parts: [{ type: "text", text }],
        fallback_text: text,
      },
    },
  };
}

function fakeClient(options: { pages?: EventsPage[] } = {}) {
  const pages = [...(options.pages ?? [])];
  const posted: Array<{ body: any; key: string }> = [];
  const client = {
    origin: "http://fake",
    async getEvents(cursor: number): Promise<EventsPage> {
      const page = pages.shift();
      return page ?? { events: [], next_cursor: cursor };
    },
    pushPage(page: EventsPage) {
      pages.push(page);
    },
    async postMessage(body: any, key: string) {
      posted.push({ body, key });
      return {
        message_id: `msg_out_${posted.length}`,
        message: {
          id: `msg_out_${posted.length}`,
          conversation_id: body.conversation_id,
          sequence: 100 + posted.length,
          sender: { kind: "agent" as const, id: "agt_1" },
          parts: body.parts,
          fallback_text: "",
        },
      };
    },
    async setTyping() {},
    async listMessages() {
      return { messages: [] };
    },
  };
  return { client: client as unknown as RelayClient & { pushPage(p: EventsPage): void }, posted };
}

function fakeEngine() {
  const turns: Array<{ conversationId: string; prompt: string }> = [];
  let permissionAsker: ((cb: TurnCallbacks) => Promise<void>) | undefined;
  let gate: Promise<void> | undefined;
  const engine: EngineAdapter = {
    engine: "claude",
    async startTurn(ref, promptText, callbacks) {
      turns.push({ conversationId: ref.conversationId, prompt: promptText });
      if (permissionAsker) await permissionAsker(callbacks);
      if (gate) await gate;
      return { text: `echo: ${promptText}`, stopReason: "end_turn" };
    },
    async abort() {},
    async dispose() {},
  };
  return {
    engine,
    turns,
    setPermissionAsker(fn: (cb: TurnCallbacks) => Promise<void>) {
      permissionAsker = fn;
    },
    setTurnGate(promise: Promise<void>) {
      gate = promise;
    },
  };
}

function makeLoop(home: string, pages: EventsPage[], debounceMs = 25) {
  const { client, posted } = fakeClient({ pages });
  const state = new StateStore(home);
  const approvals = new ApprovalStore(home);
  const fake = fakeEngine();
  const broker = new PermissionBroker(client, approvals, 60_000);
  const loop = new ReceiveLoop(client, state, fake.engine, broker, {
    ownerUserId: OWNER,
    debounceMs,
    cwd: "/tmp",
  });
  return { loop, state, approvals, client, posted, broker, ...fake };
}

function diskState(home: string): BridgeState {
  return JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
}

function pendingApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "abcde",
    conversation_id: "cnv_a",
    created_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    options: [
      { option_id: "opt_allow", label: "Allow", kind: "allow_once" },
      { option_id: "opt_deny", label: "Deny", kind: "reject_once" },
    ],
    source: "acp",
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("cursor advances only with the durably persisted queue (single atomic write)", async () => {
  const home = tempHome();
  const { loop } = makeLoop(home, [
    { events: [userMessageEvent("evt_1", "cnv_a", "hello")], next_cursor: 7 },
  ]);
  await loop.pollOnce();
  const persisted = diskState(home);
  assert.equal(persisted.cursor, 7);
  assert.equal(persisted.pending_events.cnv_a?.length, 1);
  assert.equal(persisted.pending_events.cnv_a?.[0]?.event_id, "evt_1");
  loop.stop();
});

test("cursor is not acked when persistence fails", async () => {
  const home = tempHome();
  const { client } = fakeClient({
    pages: [{ events: [userMessageEvent("evt_1", "cnv_a", "hello")], next_cursor: 9 }],
  });
  const state = new StateStore(home);
  state.persist(); // seed disk with cursor 0
  const originalPersist = state.persist.bind(state);
  let fail = true;
  state.persist = () => {
    if (fail) throw new Error("disk full");
    originalPersist();
  };
  const { engine } = fakeEngine();
  const broker = new PermissionBroker(client, new ApprovalStore(home), 60_000);
  const loop = new ReceiveLoop(client, state, engine, broker, {
    ownerUserId: OWNER,
    debounceMs: 10,
  });
  await assert.rejects(() => loop.pollOnce(), /disk full/);
  fail = false;
  // The durable view — which feeds the next poll's cursor after a restart —
  // must still be at 0 with an empty queue.
  const persisted = diskState(home);
  assert.equal(persisted.cursor, 0);
  assert.equal(Object.keys(persisted.pending_events).length, 0);
  loop.stop();
});

test("events are processed in order within a conversation", async () => {
  const home = tempHome();
  const { loop, turns } = makeLoop(home, [
    {
      events: [
        userMessageEvent("evt_1", "cnv_a", "first", 1),
        userMessageEvent("evt_2", "cnv_a", "second", 2),
      ],
      next_cursor: 2,
    },
  ]);
  await loop.pollOnce();
  await sleep(80);
  await loop.settle();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.prompt, "first\n\nsecond");
  loop.stop();
});

test("event_id dedupe: repeated delivery is enqueued once", async () => {
  const home = tempHome();
  const duplicated = userMessageEvent("evt_dup", "cnv_a", "hello");
  const { loop, turns, state } = makeLoop(home, [
    { events: [duplicated, duplicated], next_cursor: 1 },
    { events: [duplicated], next_cursor: 1 },
  ]);
  await loop.pollOnce();
  await loop.pollOnce();
  assert.equal(state.current.pending_events.cnv_a?.length, 1);
  await sleep(80);
  await loop.settle();
  assert.equal(turns.length, 1);
  loop.stop();
});

test("debounce coalesces rapid messages into one turn; separate conversations stay separate", async () => {
  const home = tempHome();
  const { loop, turns, posted } = makeLoop(
    home,
    [
      { events: [userMessageEvent("evt_1", "cnv_a", "part one")], next_cursor: 1 },
      {
        events: [
          userMessageEvent("evt_2", "cnv_a", "part two", 2),
          userMessageEvent("evt_3", "cnv_b", "other convo"),
        ],
        next_cursor: 3,
      },
    ],
    40,
  );
  await loop.pollOnce();
  await loop.pollOnce(); // arrives within the debounce window
  await sleep(150);
  await loop.settle();
  assert.equal(turns.length, 2);
  const byConversation = Object.fromEntries(turns.map((turn) => [turn.conversationId, turn.prompt]));
  assert.equal(byConversation.cnv_a, "part one\n\npart two");
  assert.equal(byConversation.cnv_b, "other convo");
  // Quiet finalization: one POST per turn, keyed on the turn.
  assert.equal(posted.length, 2);
  assert.match(posted[0]!.key, /^relay-turn-[0-9a-f]{40}$/);
  // Queue drained durably.
  assert.equal(Object.keys(diskState(home).pending_events).length, 0);
  loop.stop();
});

test("H1 regression: a message arriving mid-turn is kept and triggers a follow-up turn", async () => {
  const home = tempHome();
  const { loop, turns, client, setTurnGate } = makeLoop(
    home,
    [{ events: [userMessageEvent("evt_1", "cnv_a", "first", 1)], next_cursor: 1 }],
    20,
  );
  let releaseFirstTurn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  setTurnGate(gate);

  await loop.pollOnce();
  await sleep(60); // debounce fires; first turn is now blocked on the gate
  assert.equal(turns.length, 1);

  // Second message lands while the first turn is still running.
  client.pushPage({ events: [userMessageEvent("evt_2", "cnv_a", "second", 2)], next_cursor: 2 });
  await loop.pollOnce();
  // It must be durably queued, not clobbered by the in-flight turn.
  assert.equal(diskState(home).pending_events.cnv_a?.length, 2);

  releaseFirstTurn();
  await sleep(80); // first turn finishes; its follow-up flush is scheduled
  await loop.settle();
  await sleep(80); // follow-up debounce window
  await loop.settle();

  assert.equal(turns.length, 2, "mid-turn message must start a follow-up turn");
  assert.equal(turns[1]!.prompt, "second");
  assert.equal(Object.keys(diskState(home).pending_events).length, 0);
  loop.stop();
});

test("owner gate: non-owner messages are ignored; first owner message pins the conversation", async () => {
  const home = tempHome();
  const { loop, turns, state } = makeLoop(home, [
    {
      events: [
        userMessageEvent("evt_intruder", "cnv_x", "ignore me", 1, "usr_intruder"),
        userMessageEvent("evt_owner", "cnv_a", "hello", 1, OWNER),
      ],
      next_cursor: 2,
    },
  ]);
  await loop.pollOnce();
  assert.equal(state.current.pending_events.cnv_x, undefined);
  assert.equal(state.current.pending_events.cnv_a?.length, 1);
  // Owner conversation pinned by the first OWNER message, not the intruder's.
  assert.equal(state.current.owner_conversation_id, "cnv_a");
  await sleep(80);
  await loop.settle();
  assert.equal(turns.length, 1);
  loop.stop();
});

test("turn failure is surfaced and not replayed because tools may have partially run", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient({
    pages: [{ events: [userMessageEvent("evt_1", "cnv_a", "hello")], next_cursor: 1 }],
  });
  const state = new StateStore(home);
  const engine: EngineAdapter = {
    engine: "claude",
    async startTurn() {
      throw new Error("engine crashed");
    },
    async abort() {},
    async dispose() {},
  };
  const broker = new PermissionBroker(client, new ApprovalStore(home), 60_000);
  const loop = new ReceiveLoop(client, state, engine, broker, {
    ownerUserId: OWNER,
    debounceMs: 10,
  });
  await loop.pollOnce();
  await sleep(60);
  await loop.settle();
  assert.equal(diskState(home).pending_events.cnv_a, undefined);
  assert.equal(diskState(home).attempted_turns?.cnv_a, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body.parts[0].text, /turn failed/i);
  loop.stop();
});

test("crash marker drops an interrupted tool turn instead of executing it twice", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const state = new StateStore(home);
  const event = userMessageEvent("evt_crash", "cnv_a", "deploy it");
  const key = turnIdempotencyKey("cnv_a", [event.event_id]);
  state.current.pending_events.cnv_a = [event];
  (state.current.attempted_turns ??= {}).cnv_a = {
    turn_key: key,
    event_ids: [event.event_id],
    started_at: new Date().toISOString(),
  };
  state.persist();
  const fake = fakeEngine();
  const loop = new ReceiveLoop(
    client,
    new StateStore(home),
    fake.engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp" },
  );
  await loop.runTurn("cnv_a");
  assert.equal(fake.turns.length, 0, "interrupted engine turn must not run again");
  assert.equal(diskState(home).pending_events.cnv_a, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body.parts[0].text, /not retried automatically/);
  loop.stop();
});

test("crash recovery drops only the attempted prefix when a new message arrived", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const state = new StateStore(home);
  const attemptedEvent = userMessageEvent("evt_attempted", "cnv_a", "deploy it", 1);
  const laterEvent = userMessageEvent("evt_later", "cnv_a", "check status", 2);
  const key = turnIdempotencyKey("cnv_a", [attemptedEvent.event_id]);
  state.current.pending_events.cnv_a = [attemptedEvent, laterEvent];
  (state.current.attempted_turns ??= {}).cnv_a = {
    turn_key: key,
    event_ids: [attemptedEvent.event_id],
    started_at: new Date().toISOString(),
  };
  state.persist();
  const fake = fakeEngine();
  const loop = new ReceiveLoop(
    client,
    new StateStore(home),
    fake.engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp" },
  );

  await loop.runTurn("cnv_a");
  assert.equal(fake.turns.length, 0, "attempted prefix must not execute again");
  assert.deepEqual(
    diskState(home).pending_events.cnv_a?.map((event) => event.event_id),
    ["evt_later"],
  );
  await loop.runTurn("cnv_a");
  assert.deepEqual(fake.turns.map((turn) => turn.prompt), ["check status"]);
  assert.equal(posted.filter((entry) => entry.key.endsWith("-crashed")).length, 1);
  loop.stop();
});

test("completed reply outbox redelivers after restart without rerunning the engine", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const state = new StateStore(home);
  const event = userMessageEvent("evt_done", "cnv_a", "send it");
  const key = turnIdempotencyKey("cnv_a", [event.event_id]);
  state.current.pending_events.cnv_a = [event];
  (state.current.attempted_turns ??= {}).cnv_a = {
    turn_key: key,
    event_ids: [event.event_id],
    started_at: new Date().toISOString(),
  };
  (state.current.pending_replies ??= {})[key] = {
    conversation_id: "cnv_a",
    event_ids: [event.event_id],
    text: "finished before the crash",
    created_at: new Date().toISOString(),
  };
  state.persist();
  const fake = fakeEngine();
  const loop = new ReceiveLoop(
    client,
    new StateStore(home),
    fake.engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp" },
  );
  await loop.runTurn("cnv_a");
  assert.equal(fake.turns.length, 0);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.key, key);
  assert.equal(posted[0]!.body.parts[0].text, "finished before the crash");
  const persisted = diskState(home);
  assert.equal(persisted.pending_events.cnv_a, undefined);
  assert.equal(persisted.pending_replies?.[key], undefined);
  loop.stop();
});

test("permission card reply is consumed by the broker, not forwarded to the engine", async () => {
  const home = tempHome();
  const { loop, turns, posted, broker, approvals, setPermissionAsker } = makeLoop(home, [
    { events: [userMessageEvent("evt_1", "cnv_a", "do the thing")], next_cursor: 1 },
  ]);
  let decision: unknown;
  setPermissionAsker(async (callbacks) => {
    decision = await callbacks.onPermissionAsk({
      requestId: "perm_test1",
      toolName: "bash",
      options: [
        { optionId: "opt_allow", label: "Allow", kind: "allow_once" },
        { optionId: "opt_deny", label: "Deny", kind: "reject_once" },
      ],
    });
  });
  await loop.pollOnce();
  await sleep(80);
  // While the engine turn is blocked on the ask, the approval file is durable
  // and the card is posted.
  const pending = approvals.list();
  assert.equal(pending.length, 1);
  const requestId = pending[0]!.request_id;
  assert.match(requestId, /^[a-km-z]{5}$/);
  const card = posted.find((entry) => entry.key === `agent-perm-${requestId}`);
  assert.ok(card, "permission card was posted");
  // Channel-plugin wire shape: text part with the yes/no fallback + data part.
  assert.equal(card!.body.parts[0].type, "text");
  assert.match(card!.body.parts[0].text, new RegExp(`yes ${requestId}`));
  const data = card!.body.parts[1];
  assert.equal(data.type, "data");
  assert.equal(data.data.kind, "agent_permission_request");
  assert.equal(data.data.request_id, requestId);
  assert.deepEqual(
    data.data.options.map((option: any) => option.id),
    ["allow", "deny"],
  );
  assert.deepEqual(data.data.options[0].origin, {
    kind: "agent_permission_request",
    request_id: requestId,
  });
  assert.deepEqual(card!.body.suggestions, [
    { text: `yes ${requestId}` },
    { text: `no ${requestId}` },
  ]);

  // Phone taps Allow → text fallback reply "yes <id>".
  const tap = userMessageEvent("evt_tap", "cnv_a", `yes ${requestId}`, 3);
  assert.equal(broker.consumeReply(tap.data!.message!), true);
  await loop.settle();
  // The verdict reached the blocked engine callback mapped onto the ACP option.
  assert.deepEqual(decision, { behavior: "selected", optionId: "opt_allow" });
  // The tap never became an engine prompt, and the file was consumed.
  assert.equal(turns.length, 1);
  assert.equal(approvals.list().length, 0);
  loop.stop();
});

test("M1 regression: a verdict from the wrong conversation does not resolve the approval", () => {
  const home = tempHome();
  const { client } = fakeClient();
  const approvals = new ApprovalStore(home);
  approvals.create(pendingApproval({ request_id: "abcde", conversation_id: "cnv_a" }));
  const broker = new PermissionBroker(client, approvals, 60_000);

  const wrongConversation = userMessageEvent("evt_w", "cnv_other", "yes abcde", 5);
  // Verdict-shaped → swallowed (never an engine prompt) …
  assert.equal(broker.consumeReply(wrongConversation.data!.message!), true);
  // … but the approval stays pending and unresolved.
  const still = approvals.get("abcde");
  assert.ok(still);
  assert.equal(still!.resolution, undefined);

  // The right conversation resolves it.
  const right = userMessageEvent("evt_r", "cnv_a", "yes abcde", 6);
  assert.equal(broker.consumeReply(right.data!.message!), true);
  assert.equal(approvals.get("abcde")?.resolution?.behavior, "allow");
});

test("H2: hook-armed approval is resolved by the loop and consumed by the hook waiter", () => {
  const home = tempHome();
  const { client } = fakeClient();
  // Hook process arms the approval (create-once).
  const hookStore = new ApprovalStore(home);
  hookStore.create(pendingApproval({ request_id: "fghij", source: "hook" }));
  assert.throws(() => hookStore.create(pendingApproval({ request_id: "fghij" })), /EEXIST/);

  // Loop process (separate store instance) sees the tap and writes the resolution.
  const broker = new PermissionBroker(client, new ApprovalStore(home), 60_000);
  const tap = userMessageEvent("evt_tap", "cnv_a", "no fghij", 4);
  assert.equal(broker.consumeReply(tap.data!.message!), true);

  // Hook waiter reads the resolution and consumes the file.
  const resolved = hookStore.get("fghij");
  assert.equal(resolved?.resolution?.behavior, "deny");
  hookStore.consume("fghij");
  assert.equal(hookStore.get("fghij"), undefined);
});

test("M2 regression: sweep keeps unconsumed in-window resolutions, ages out only past grace", () => {
  const home = tempHome();
  const approvals = new ApprovalStore(home);
  // Resolved but unconsumed, deadline passed but inside grace → must survive.
  approvals.create(
    pendingApproval({
      request_id: "aaaaa",
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
      resolution: { behavior: "allow", decided_at: new Date().toISOString() },
    }),
  );
  // Deadline + grace long past → aged out even with a resolution.
  approvals.create(
    pendingApproval({
      request_id: "bbbbb",
      deadline_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      resolution: { behavior: "allow", decided_at: new Date().toISOString() },
    }),
  );
  const removed = approvals.sweep(Date.now(), 10 * 60 * 1000);
  assert.deepEqual(removed, ["bbbbb"]);
  assert.ok(approvals.get("aaaaa"), "in-grace unconsumed resolution must survive the sweep");
  assert.equal(approvals.get("bbbbb"), undefined);
});

test("approval timeout denies via the reject option and consumes the file", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const approvals = new ApprovalStore(home);
  const broker = new PermissionBroker(client, approvals, 50);
  const decision = await broker.ask(
    "cnv_a",
    {
      requestId: "perm_t",
      toolName: "bash",
      options: [
        { optionId: "opt_allow", label: "Allow", kind: "allow_once" },
        { optionId: "opt_deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "claude",
  );
  assert.deepEqual(decision, { behavior: "selected", optionId: "opt_deny" });
  assert.equal(posted.length, 1);
  assert.equal(approvals.list().length, 0);
});

test("approval waiter is armed before posting, so an immediate phone reply wins", async () => {
  const home = tempHome();
  const approvals = new ApprovalStore(home);
  let broker!: PermissionBroker;
  const client = {
    origin: "https://api.relayapp.im",
    async postMessage(body: any) {
      const requestId = body.parts[1].data.request_id as string;
      const tap = userMessageEvent("evt_fast", "cnv_a", `yes ${requestId}`, 2);
      assert.equal(broker.consumeReply(tap.data!.message!), true);
      return { message_id: "msg_card", message: { sequence: 1 } };
    },
  } as unknown as RelayClient;
  broker = new PermissionBroker(client, approvals, 60_000);
  const decision = await broker.ask(
    "cnv_a",
    {
      requestId: "engine_request",
      toolName: "bash",
      inputPreview: "git status",
      options: [
        { optionId: "allow", label: "Allow", kind: "allow_once" },
        { optionId: "deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "claude",
  );
  assert.deepEqual(decision, { behavior: "selected", optionId: "allow" });
  assert.equal(approvals.list().length, 0);
});

test("security-sensitive approval input is complete or the ask fails closed", async () => {
  const full = `printf start\n${"x".repeat(2_000)}\nprintf dangerous-suffix`;
  const card = buildPermissionCard({
    requestId: "abcde",
    conversationId: "cnv_a",
    engineLabel: "Codex",
    toolName: "shell",
    inputPreview: full,
  });
  assert.equal(card.body.parts[1]!.data.input_preview, full);
  assert.match(card.body.parts[0]!.text as string, /dangerous-suffix$/m);
  assert.throws(
    () =>
      buildPermissionCard({
        requestId: "abcde",
        conversationId: "cnv_a",
        engineLabel: "Codex",
        inputPreview: "x".repeat(MAX_PERMISSION_PREVIEW_CHARS + 1),
      }),
    /only permits approval when the full/,
  );

  const { client, posted } = fakeClient();
  const broker = new PermissionBroker(client, new ApprovalStore(tempHome()), 60_000);
  const decision = await broker.ask(
    "cnv_a",
    {
      requestId: "too_large",
      inputPreview: "x".repeat(MAX_PERMISSION_PREVIEW_CHARS + 1),
      options: [
        { optionId: "allow", label: "Allow", kind: "allow_once" },
        { optionId: "deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "codex",
  );
  assert.deepEqual(decision, { behavior: "selected", optionId: "deny" });
  assert.equal(posted.length, 0, "unsafe partial card must never be sent");

  const incomplete = await broker.ask(
    "cnv_a",
    {
      requestId: "incomplete",
      toolName: "shell",
      title: "Run command",
      inputComplete: false,
      options: [
        { optionId: "allow", label: "Allow", kind: "allow_once" },
        { optionId: "deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "claude",
  );
  assert.deepEqual(incomplete, { behavior: "selected", optionId: "deny" });
  assert.equal(posted.length, 0, "missing raw input must never post an approval");
});

test("verdict parsing matches the channel plugin: data-part tap and text fallback", () => {
  assert.deepEqual(parseVerdictText("  YES abcde "), { request_id: "abcde", behavior: "allow" });
  assert.deepEqual(parseVerdictText("n zzzzz"), { request_id: "zzzzz", behavior: "deny" });
  assert.equal(parseVerdictText("yes ablde"), null); // "l" is outside the alphabet
  assert.equal(parseVerdictText("sounds good"), null);
  assert.deepEqual(
    parseVerdictDataPart({
      origin: { kind: "agent_permission_request", request_id: "abcde" },
      option_id: "allow",
    }),
    { request_id: "abcde", behavior: "allow" },
  );
  assert.deepEqual(
    parseVerdictDataPart({ origin: { request_id: "abcde" }, option: "deny" }),
    { request_id: "abcde", behavior: "deny" },
  );
  assert.deepEqual(
    parseVerdictDataPart({ kind: "agent_permission_request", request_id: "mnopq", behavior: "reject" }),
    { request_id: "mnopq", behavior: "deny" },
  );
  assert.equal(parseVerdictDataPart({ request_id: "toolong", option: "allow" }), null);
});

test("idempotency key is stable for the exact event batch and prompt text falls back", () => {
  assert.equal(turnIdempotencyKey("cnv_a", ["evt_9"]), turnIdempotencyKey("cnv_a", ["evt_9"]));
  assert.notEqual(turnIdempotencyKey("cnv_a", ["evt_9"]), turnIdempotencyKey("cnv_a", ["evt_8"]));
  assert.notEqual(
    turnIdempotencyKey("cnv_a", ["evt_9"]),
    turnIdempotencyKey("cnv_a", ["evt_9", "evt_10"]),
  );
  const text = promptTextFromMessages([
    {
      id: "m1",
      conversation_id: "cnv_a",
      sequence: 1,
      sender: { kind: "user", id: "u" },
      parts: [{ type: "media", url: "https://x" }],
      fallback_text: "[photo]",
    },
  ]);
  assert.equal(text, "[photo]");
});
