import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PERMISSION_REPLY_RE,
  PendingRequests,
  buildPermissionCard,
  buildReply,
  classifyEvent,
  parseVerdictDataPart,
  parseVerdictText,
  sanitizeRelayedText,
} from "../src/bridge.ts";
import type { RelayEvent } from "../src/types.ts";

const OWNER = "usr_owner1";

function messageEvent(overrides: {
  sender?: { kind: string; id: string };
  parts?: unknown[];
  event_type?: string;
  conversation_id?: string;
  fallback_text?: string;
}): RelayEvent {
  return {
    event_id: "evt_1",
    event_type: overrides.event_type ?? "message.received",
    agent_id: "agt_1",
    created_at: "2026-07-17T00:00:00.000Z",
    data: {
      message: {
        id: "msg_1",
        conversation_id: overrides.conversation_id ?? "cnv_1",
        sequence: 7,
        sender: overrides.sender ?? { kind: "user", id: OWNER },
        parts: overrides.parts ?? [{ part_index: 0, type: "text", text: "hello" }],
        reply_to: null,
        fallback_text: overrides.fallback_text ?? "hello",
        status: "sent",
        created_at: "2026-07-17T00:00:00.000Z",
      },
    },
  };
}

describe("event → notification mapping", () => {
  it("maps a message.received text message to a channel notification", () => {
    const action = classifyEvent(messageEvent({}), OWNER);
    assert(action.kind === "message");
    assert.equal(action.content, "hello");
    assert.deepEqual(action.meta, { chat_id: "cnv_1", sender: OWNER });
  });

  it("joins multiple text parts with newlines", () => {
    const action = classifyEvent(
      messageEvent({
        parts: [
          { part_index: 0, type: "text", text: "line one" },
          { part_index: 1, type: "media", attachment_id: "att_1" },
          { part_index: 2, type: "text", text: "line two" },
        ],
      }),
      OWNER,
    );
    assert(action.kind === "message");
    assert.equal(action.content, "line one\nline two");
  });

  it("falls back to fallback_text for non-text messages", () => {
    const action = classifyEvent(
      messageEvent({
        parts: [{ part_index: 0, type: "voice_memo", attachment_id: "att_1" }],
        fallback_text: "Voice memo",
      }),
      OWNER,
    );
    assert(action.kind === "message");
    assert.equal(action.content, "Voice memo");
  });

  it("ignores non-message event types", () => {
    const action = classifyEvent(messageEvent({ event_type: "message.read" }), OWNER);
    assert.equal(action.kind, "ignore");
  });

  it("ignores malformed payloads", () => {
    const event: RelayEvent = {
      event_id: "evt_x",
      event_type: "message.received",
      agent_id: "agt_1",
      created_at: "2026-07-17T00:00:00.000Z",
      data: { nope: true },
    };
    assert.equal(classifyEvent(event, OWNER).kind, "ignore");
  });
});

describe("sender gating", () => {
  it("blocks user senders that are not the owner", () => {
    const action = classifyEvent(
      messageEvent({ sender: { kind: "user", id: "usr_stranger" } }),
      OWNER,
    );
    assert.equal(action.kind, "blocked_sender");
  });

  it("ignores non-user senders even with a matching id", () => {
    const action = classifyEvent(messageEvent({ sender: { kind: "agent", id: OWNER } }), OWNER);
    assert.equal(action.kind, "ignore");
  });

  it("a non-owner verdict reply is blocked, not emitted", () => {
    const action = classifyEvent(
      messageEvent({
        sender: { kind: "user", id: "usr_stranger" },
        parts: [{ part_index: 0, type: "text", text: "yes abcde" }],
      }),
      OWNER,
    );
    assert.equal(action.kind, "blocked_sender");
  });

  it("passes any user sender when owner is unpinned (TOFU handled upstream)", () => {
    const action = classifyEvent(
      messageEvent({ sender: { kind: "user", id: "usr_first" } }),
      null,
    );
    assert.equal(action.kind, "message");
  });
});

describe("verdict text regex", () => {
  const cases: [string, string, "allow" | "deny"][] = [
    ["yes abcde", "abcde", "allow"],
    ["y abcde", "abcde", "allow"],
    ["no abcde", "abcde", "deny"],
    ["n abcde", "abcde", "deny"],
    ["  YES ABCDE  ", "abcde", "allow"],
    ["Yes\tqwert", "qwert", "allow"],
  ];
  for (const [input, id, behavior] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      const verdict = parseVerdictText(input);
      assert.ok(verdict);
      assert.equal(verdict.request_id, id);
      assert.equal(verdict.behavior, behavior);
    });
  }

  const rejects = [
    "yes", // no id
    "approve it",
    "yes abcd", // 4 letters
    "yes abcdef", // 6 letters
    "yes ablde", // contains 'l' (not in the id alphabet)
    "yes abc1e", // digit
    "maybe abcde",
    "yes abcde now", // trailing words
  ];
  for (const input of rejects) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(parseVerdictText(input), null);
    });
  }

  it("matches the documented channels-reference regex source", () => {
    assert.equal(PERMISSION_REPLY_RE.source, String.raw`^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$`);
  });
});

describe("verdict data-part tap", () => {
  it("parses an origin-tagged option tap", () => {
    const verdict = parseVerdictDataPart({
      kind: "option_tap",
      origin: { kind: "claude_permission_request", request_id: "abcde" },
      option_id: "allow",
    });
    assert.deepEqual(verdict, { request_id: "abcde", behavior: "allow" });
  });

  it("parses a deny tap with flat request_id", () => {
    const verdict = parseVerdictDataPart({
      kind: "claude_permission_request",
      request_id: "kmnop",
      behavior: "deny",
    });
    assert.deepEqual(verdict, { request_id: "kmnop", behavior: "deny" });
  });

  it("rejects ids outside the alphabet and missing options", () => {
    assert.equal(parseVerdictDataPart({ request_id: "abc1e", option_id: "allow" }), null);
    assert.equal(parseVerdictDataPart({ request_id: "abcde" }), null);
    assert.equal(parseVerdictDataPart({ option_id: "allow" }), null);
    assert.equal(parseVerdictDataPart("yes abcde"), null);
    assert.equal(parseVerdictDataPart(null), null);
  });

  it("classifyEvent routes a tap reply for an OPEN request to a verdict, not chat", () => {
    const action = classifyEvent(
      messageEvent({
        parts: [
          {
            part_index: 0,
            type: "data",
            data: {
              kind: "option_tap",
              origin: { kind: "claude_permission_request", request_id: "abcde" },
              option_id: "deny",
            },
          },
        ],
        fallback_text: "Deny",
      }),
      OWNER,
      (id) => id === "abcde",
    );
    assert(action.kind === "verdict");
    assert.deepEqual(action.verdict, { request_id: "abcde", behavior: "deny" });
  });

  it("classifyEvent routes a text verdict reply for an OPEN request to a verdict, not chat", () => {
    const action = classifyEvent(
      messageEvent({ parts: [{ part_index: 0, type: "text", text: "no kmnop" }] }),
      OWNER,
      (id) => id === "kmnop",
    );
    assert(action.kind === "verdict");
    assert.deepEqual(action.verdict, { request_id: "kmnop", behavior: "deny" });
  });
});

describe("verdict gating on outstanding requests", () => {
  it('natural chat like "no worry" is NOT swallowed when no request is open', () => {
    // "worry" and "right" are five id-alphabet letters, so the raw regex
    // matches them; the pending gate must let them through as chat.
    for (const text of ["no worry", "yes right", "y think", "n empty"]) {
      const action = classifyEvent(
        messageEvent({ parts: [{ part_index: 0, type: "text", text }] }),
        OWNER,
      );
      assert(action.kind === "message", `${JSON.stringify(text)} should be chat`);
      assert.equal(action.content, text);
    }
  });

  it("a matching reply for a different (non-open) id falls through to chat", () => {
    const action = classifyEvent(
      messageEvent({ parts: [{ part_index: 0, type: "text", text: "yes worry" }] }),
      OWNER,
      (id) => id === "abcde",
    );
    assert(action.kind === "message");
  });

  it("a data-part tap with a non-open id is not a verdict", () => {
    const action = classifyEvent(
      messageEvent({
        parts: [
          {
            part_index: 0,
            type: "data",
            data: { kind: "option_tap", origin: { request_id: "abcde" }, option_id: "allow" },
          },
          { part_index: 1, type: "text", text: "Allow" },
        ],
      }),
      OWNER,
      () => false,
    );
    assert(action.kind === "message");
    assert.equal(action.content, "Allow");
  });

  it("PendingRequests: first verdict resolves the id, a second no longer matches", () => {
    const pending = new PendingRequests();
    pending.add("abcde");
    assert.equal(pending.has("abcde"), true);
    pending.resolve("abcde");
    assert.equal(pending.has("abcde"), false);
    const action = classifyEvent(
      messageEvent({ parts: [{ part_index: 0, type: "text", text: "yes abcde" }] }),
      OWNER,
      (id) => pending.has(id),
    );
    assert(action.kind === "message");
  });

  it("PendingRequests: ids expire after the TTL", () => {
    let now = 0;
    const pending = new PendingRequests({ ttlMs: 1000, now: () => now });
    pending.add("abcde");
    assert.equal(pending.has("abcde"), true);
    now = 999;
    assert.equal(pending.has("abcde"), true);
    now = 1001;
    assert.equal(pending.has("abcde"), false);
  });
});

describe("permission card", () => {
  it("builds a text part + origin-tagged data part with a stable idempotency key", () => {
    const card = buildPermissionCard(
      {
        request_id: "abcde",
        tool_name: "Bash",
        description: "List repository files",
        input_preview: '{"command": "ls -la"}',
      },
      "cnv_9",
    );
    assert.equal(card.idempotencyKey, "claude-perm-abcde");
    assert.ok(card.idempotencyKey.length >= 8);
    assert.equal(card.body.conversation_id, "cnv_9");
    assert.equal(card.body.parts.length, 2);

    const text = card.body.parts[0];
    assert.equal(text.type, "text");
    assert.ok(text.text?.includes("Claude wants to run Bash: List repository files"));
    assert.ok(text.text?.includes('{"command": "ls -la"}'));
    assert.ok(text.text?.includes('Reply "yes abcde" to allow or "no abcde" to deny.'));

    const data = card.body.parts[1];
    assert.equal(data.type, "data");
    const payload = data.data as {
      kind: string;
      request_id: string;
      options: { id: string; label: string; origin: { request_id: string } }[];
    };
    assert.equal(payload.kind, "claude_permission_request");
    assert.equal(payload.request_id, "abcde");
    assert.deepEqual(
      payload.options.map((o) => o.id),
      ["allow", "deny"],
    );
    for (const option of payload.options) {
      assert.equal(option.origin.request_id, "abcde");
    }
  });

  it("sanitizes untrusted fields (bidi controls stripped, whitespace folded, clamped)", () => {
    const hostile = "run‮ evil ​⁦command⁩\n\n\ttrailing";
    assert.equal(sanitizeRelayedText(hostile, 100), "run evil command trailing");
    const long = "x".repeat(3000);
    assert.equal(sanitizeRelayedText(long, 100).length, 100);
    const card = buildPermissionCard(
      { request_id: "abcde", tool_name: "Bash", description: hostile, input_preview: "" },
      "cnv_9",
    );
    const text = card.body.parts[0].text ?? "";
    assert.ok(!text.includes("‮"));
    assert.ok(text.includes("run evil command trailing"));
  });
});

describe("reply body", () => {
  it("builds a single text part message", () => {
    assert.deepEqual(buildReply("cnv_3", "on it"), {
      conversation_id: "cnv_3",
      parts: [{ type: "text", text: "on it" }],
    });
  });
});
