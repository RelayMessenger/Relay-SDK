import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { acpPermission } from "./acp-bridge.js";
import { createHash } from "node:crypto";
import {
  APPROVAL_REPLY_PREFIX,
  OwnerApprovals,
  approvalPart,
  cardDescription,
  inputCard,
  inputDetail,
  noOwnerLine,
  piApprovals,
  type ApprovalClient,
  type ApprovalRequest,
} from "./approvals.js";

const AGENT = { id: "agent-id", handle: "coder.agent", kind: "agent" as const, display_name: "Coder", owner: null };
const OWNERS = [
  { id: "owner-1", handle: "ada", display_name: "Ada" },
  { id: "owner-2", handle: "grace", display_name: "Grace" },
];

/** Relay, reduced to what the approvals touch, with every call written down. */
const fakeRelay = (owners = OWNERS) => {
  const created: { from: string; to: string[]; parts: unknown[] }[] = [];
  const sent: { chatId: string; message: { parts: unknown[]; reply_to?: unknown } }[] = [];
  const client = {
    me: { retrieve: async () => ({ ...AGENT, owner_people: owners }) },
    chats: {
      create: async (body: { from: string; to: string[]; message: { parts: unknown[] } }) => {
        created.push({ from: body.from, to: body.to, parts: body.message.parts });
        return { chat: { id: `chat-with-${body.to[0]}`, message: { id: `card-for-${body.to[0]}` } } };
      },
      messages: {
        send: async (chatId: string, body: { message: { parts: unknown[]; reply_to?: unknown } }) => {
          sent.push({ chatId, message: body.message });
          return {};
        },
      },
    },
  } as unknown as ApprovalClient;
  return { client, created, sent };
};

const REQUEST: ApprovalRequest = {
  harness: "Gemini CLI",
  tool: "uname -a",
  title: "Gemini CLI asks to run a command.",
  summary: "uname -a",
  detail: "command: uname -a",
  extra: false,
  choices: [
    { id: "proceed_once", label: "Allow once", decision: "allow_once" },
    { id: "proceed_always", label: "Allow for this session", decision: "allow_session" },
    { id: "cancel", label: "Reject", decision: "deny" },
  ],
};

/**
 * A tap on a card's reply, as `message.received` carries it: the label as
 * plain text, then `suggestion_response` with the reply's id, replying to the
 * card part (Relay-Server contracts/developer/openapi.yaml, `SuggestionResponsePart`).
 */
/** The reply id an approval card gives a choice: the documented prefix, then the harness's id. */
const R = (id: string): string => `${APPROVAL_REPLY_PREFIX}${id}`;

const tap = (card: string, from: { handle: string; kind: "user" | "agent" }, id = "proceed_once", label = "Allow once", replyIdOf = R): RelayWebhookEvent => ({
  event_id: `tap-${Math.random()}`,
  event_type: "message.received",
  data: {
    id: `tap-${Math.random()}`,
    chat: { id: `chat-with-${from.handle}` },
    direction: "inbound",
    sender_handle: { handle: from.handle, kind: from.kind },
    parts: [{ type: "text", value: label }, { type: "suggestion_response", id: replyIdOf(id), label }],
    reply_to: { message_id: card, part_index: 0 },
  },
} as unknown as RelayWebhookEvent);

/** A pick on a single-choice list, as `message.received` carries it (`SelectionResponsePart`). */
const pick = (card: string, from: string, id: string): RelayWebhookEvent => ({
  event_id: `pick-${Math.random()}`,
  event_type: "message.received",
  data: {
    id: `pick-${Math.random()}`,
    chat: { id: `chat-with-${from}` },
    direction: "inbound",
    sender_handle: { handle: from, kind: "user" },
    parts: [{ type: "text", value: `• ${id}` }, { type: "selection_response", selected_values: [R(id)], selected_ids: [R(id)] }],
    reply_to: { message_id: card, part_index: 0 },
  },
} as unknown as RelayWebhookEvent);

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

/** The outcome reply each card got: its chat, the card it answers, and its words. */
const replies = (sent: { chatId: string; message: { parts: unknown[]; reply_to?: unknown } }[]) =>
  sent.map(({ chatId, message }) => ({ chatId, reply_to: message.reply_to, parts: message.parts }));

describe("owner approvals", () => {
  it("sends each owner's own chat with the agent a rich card whose replies are the harness's choices, and nobody else", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 50 });
    await flush();
    expect(relay.created.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "coder.agent", to: ["ada"] },
      { from: "coder.agent", to: ["grace"] },
    ]);
    expect(relay.created[0]?.parts).toEqual([{
      type: "rich_card",
      title: "Gemini CLI asks to run a command.",
      description: "uname -a",
      suggestions: [
        { type: "reply", label: "Allow once", id: "relay-approval:proceed_once" },
        { type: "reply", label: "Allow for this session", id: "relay-approval:proceed_always" },
        { type: "reply", label: "Reject", id: "relay-approval:cancel" },
      ],
    }]);
    await asked;
  });

  it("takes an owner's tap as the answer and replies to every owner's card with what happened", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const asked = approvals.ask(REQUEST);
    await flush();
    expect(await approvals.take(tap("card-for-grace", { handle: "grace", kind: "user" }, "proceed_always", "Allow for this session"))).toBe(true);
    expect(await asked).toEqual({ reason: "answered", by: "grace", choice: REQUEST.choices[1] });
    expect(replies(relay.sent)).toEqual([
      { chatId: "chat-with-ada", reply_to: { message_id: "card-for-ada", part_index: 0 }, parts: [{ type: "text", value: "@grace allowed this for this session." }] },
      { chatId: "chat-with-grace", reply_to: { message_id: "card-for-grace", part_index: 0 }, parts: [{ type: "text", value: "@grace allowed this for this session." }] },
    ]);
  });

  it("hands the harness the choice whose id the tap carries, never another", async () => {
    for (const [index, choice] of REQUEST.choices.entries()) {
      const approvals = new OwnerApprovals({ client: fakeRelay().client, say: () => undefined });
      const asked = approvals.ask(REQUEST);
      await flush();
      await approvals.take(tap("card-for-ada", { handle: "ada", kind: "user" }, choice.id, choice.label));
      expect((await asked).choice).toBe(REQUEST.choices[index]);
    }
  });

  it("does not register a tap from anyone who is not an owner, sends nothing, and leaves the card to an owner", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 1_000 });
    await flush();
    expect(await approvals.take(tap("card-for-ada", { handle: "mallory", kind: "user" }))).toBe(true);
    expect(await approvals.take(tap("card-for-ada", { handle: "ada", kind: "agent" }))).toBe(true);
    // An id the card never offered answers nothing either.
    expect(await approvals.take(tap("card-for-ada", { handle: "ada", kind: "user" }, "proceed_forever"))).toBe(true);
    await flush();
    // No message: a refusal is never a message sent on someone's behalf.
    expect(relay.sent).toEqual([]);
    // The card is still open: an owner's tap answers it.
    expect(await approvals.take(tap("card-for-ada", { handle: "ada", kind: "user" }, "cancel", "Reject"))).toBe(true);
    expect(await asked).toEqual({ reason: "answered", by: "ada", choice: REQUEST.choices[2] });
    expect(relay.sent).toHaveLength(2);
  });

  it("denies and replies to the card when nobody answers in time", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    expect(await approvals.ask({ ...REQUEST, timeoutMs: 20 })).toEqual({ reason: "timeout" });
    expect(replies(relay.sent)[0]).toEqual({ chatId: "chat-with-ada", reply_to: { message_id: "card-for-ada", part_index: 0 }, parts: [{ type: "text", value: "Timed out, not approved." }] });
    // A late tap on the settled card (its replies stay tappable) is dropped, never a new turn.
    expect(await approvals.take(tap("card-for-ada", { handle: "ada", kind: "user" }))).toBe(true);
  });

  it("denies, sends nothing, and says how to link a phone when no owner has an app account", async () => {
    const relay = fakeRelay([]);
    const said: string[] = [];
    const approvals = new OwnerApprovals({ client: relay.client, say: (line) => said.push(line) });
    expect(await approvals.ask(REQUEST)).toEqual({ reason: "no_owner" });
    expect(relay.created).toEqual([]);
    expect(said).toEqual([noOwnerLine(REQUEST)]);
    expect(said[0]).toContain("relay phone link");
  });

  it("leaves other cards' taps and ordinary messages to the bridge", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 30 });
    await flush();
    expect(await approvals.take(tap("ride-1042", { handle: "ada", kind: "user" }, "seat_12a", "12A", (id) => id))).toBe(false);
    expect(await approvals.take({ event_type: "message.received", event_id: "m", data: { parts: [{ type: "text", value: "Allow once" }] } } as unknown as RelayWebhookEvent)).toBe(false);
    expect(await approvals.take({ event_type: "message.received", event_id: "r", data: { parts: [{ type: "text", value: "hi" }], reply_to: { message_id: "card-for-ada", part_index: 0 } } } as unknown as RelayWebhookEvent)).toBe(false);
    expect(await asked).toEqual({ reason: "timeout" });
  });

  it("takes an owner's tap that arrives before Relay has answered the card's own send", async () => {
    // The card reaches the owner's phone, and the owner taps it, before the
    // HTTP response that names the card's message id reaches this process.
    const relay = fakeRelay([OWNERS[0]!]);
    let approvals!: OwnerApprovals;
    let early: Promise<boolean> | undefined;
    const create = relay.client.chats.create.bind(relay.client.chats);
    (relay.client.chats as { create: unknown }).create = async (body: Parameters<typeof create>[0]) => {
      const sent = await create(body);
      early = approvals.take(tap("card-for-ada", { handle: "ada", kind: "user" }, "proceed_always", "Allow for this session"));
      await early;
      return sent;
    };
    approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 200 });
    expect(await asked).toEqual({ reason: "answered", by: "ada", choice: REQUEST.choices[1] });
    expect(await early).toBe(true);
  });

  it("forgets an early tap on a card no prompt of this process registers", async () => {
    const relay = fakeRelay([OWNERS[0]!]);
    let approvals!: OwnerApprovals;
    const create = relay.client.chats.create.bind(relay.client.chats);
    (relay.client.chats as { create: unknown }).create = async (body: Parameters<typeof create>[0]) => {
      // A tap on another bridge's card while this card is in flight.
      expect(await approvals.take(tap("card-of-another-bridge", { handle: "ada", kind: "user" }))).toBe(true);
      return create(body);
    };
    approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    expect(await approvals.ask({ ...REQUEST, timeoutMs: 30 })).toEqual({ reason: "timeout" });
  });

  it("after a restart, drops a tap on an approval card it no longer holds instead of starting a turn", async () => {
    // A fresh process: nothing pending, nothing settled. The card was sent by the process before it.
    const approvals = new OwnerApprovals({ client: fakeRelay().client, say: () => undefined });
    expect(await approvals.take(tap("card-sent-before-restart", { handle: "ada", kind: "user" }, "proceed_once"))).toBe(true);
    expect(await approvals.take(pick("card-sent-before-restart", "ada", "green"))).toBe(true);
    // Another card's reply, with no approval prefix, is still the bridge's to answer.
    expect(await approvals.take(tap("card-sent-before-restart", { handle: "ada", kind: "user" }, "seat_12a", "12A", (id) => id))).toBe(false);
  });

  it("refuses loudly, sending nothing, a prompt with more choices than a list holds", async () => {
    const relay = fakeRelay();
    const said: string[] = [];
    const approvals = new OwnerApprovals({ client: relay.client, say: (line) => said.push(line) });
    const choices = Array.from({ length: 26 }, (_, index) => ({ id: `option_${index}`, label: `Option ${index}`, decision: "choice" as const }));
    await expect(approvals.ask({ ...REQUEST, harness: "Pi", choices })).rejects.toThrow("Pi offered 26 choices; a Relay approval list holds at most 25, so it was not sent.");
    expect(relay.created).toEqual([]);
    expect(said).toEqual(["Pi offered 26 choices; a Relay approval list holds at most 25, so it was not sent."]);
    // 25 is still asked.
    const asked = approvals.ask({ ...REQUEST, harness: "Pi", choices: choices.slice(0, 25), timeoutMs: 10 });
    await expect(asked).resolves.toEqual({ reason: "timeout" });
    expect(relay.created).toHaveLength(2);
  });

  it("stops waiting when the harness cancels the prompt", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const stop = new AbortController();
    const asked = approvals.ask({ ...REQUEST, signal: stop.signal });
    await flush();
    stop.abort();
    expect(await asked).toEqual({ reason: "aborted" });
  });

  it("asks a choice of more than four as a single-choice list, and takes the pick", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const options = ["red", "orange", "yellow", "green", "blue"];
    const request: ApprovalRequest = { ...REQUEST, harness: "Pi", title: "Pick a colour", summary: "", detail: "", choices: options.map((id) => ({ id, label: id, decision: "choice" })) };
    const asked = approvals.ask(request);
    await flush();
    expect(relay.created[0]?.parts).toEqual([{ type: "selection", title: "Pick a colour", multiple: false, options: options.map((id) => ({ id: R(id), label: id })) }]);
    expect(await approvals.take(pick("card-for-ada", "ada", "green"))).toBe(true);
    expect(await asked).toEqual({ reason: "answered", by: "ada", choice: request.choices[3] });
  });
});

const CLAUDE = { harness: "Claude Code", choices: REQUEST.choices };
/** A Claude Code prompt as `claudePermission` asks it. */
const claude = (tool: string, input: Record<string, unknown>): ApprovalRequest => ({ ...CLAUDE, tool, ...inputCard(input) });

describe("the card stays inside the contract's limits", () => {
  it("cuts a long title, description and reply label, and stands a hash of an over-long id in for it", () => {
    const request: ApprovalRequest = {
      ...REQUEST,
      title: "t".repeat(300),
      summary: "s".repeat(3_000),
      choices: [{ id: "x".repeat(300), label: "Allow this one time only, please", decision: "allow_once" }],
    };
    const part = approvalPart(request) as { title: string; description: string; suggestions: { label: string; id: string }[] };
    expect(part.title).toHaveLength(200);
    expect(part.description).toHaveLength(2_000);
    expect(part.description.endsWith("…")).toBe(true);
    const hash = createHash("sha256").update("x".repeat(300)).digest("hex");
    expect(part.suggestions).toEqual([{ type: "reply", label: "Allow this one time only…", id: `relay-approval:sha256:${hash}` }]);
    expect(part.suggestions[0]!.id.length).toBeLessThanOrEqual(256);
  });

  it("gives over-long ids distinct reply ids that no real id shares, and maps each back to its own choice", async () => {
    const choices = [
      { id: `${"x".repeat(299)}a`, label: "First", decision: "choice" as const },
      { id: `${"x".repeat(299)}b`, label: "Second", decision: "choice" as const },
      { id: "choice_0", label: "Third", decision: "choice" as const },
      { id: "choice_1", label: "Fourth", decision: "choice" as const },
    ];
    const part = approvalPart({ ...REQUEST, choices }) as { suggestions: { id: string }[] };
    const ids = part.suggestions.map((suggestion) => suggestion.id);
    expect(new Set(ids).size).toBe(4);
    for (const [index, choice] of choices.entries()) {
      const approvals = new OwnerApprovals({ client: fakeRelay().client, say: () => undefined });
      const asked = approvals.ask({ ...REQUEST, choices });
      await flush();
      await approvals.take(tap("card-for-ada", { handle: "ada", kind: "user" }, ids[index]!, choice.label, (id) => id));
      expect((await asked).choice).toBe(choice);
    }
  });

  it("leaves the description out when there is nothing to say", () => {
    expect(approvalPart({ ...REQUEST, summary: "  ", detail: "" })).not.toHaveProperty("description");
  });
});

describe("the card's description: the command and its note, or the whole input when it holds more", () => {
  it("shows a short command alone", () => {
    expect(cardDescription(claude("Bash", { command: "npm test -- --watch=false" }))).toBe("npm test -- --watch=false");
  });

  it("shows Bash's own description as a line under the command", () => {
    expect(cardDescription(claude("Bash", { command: "npm test", description: "Run the tests" }))).toBe("npm test\n\nRun the tests");
  });

  it("shows a multi-line command whole", () => {
    expect(cardDescription(claude("Bash", { command: "cd app &&\nnpm test" }))).toBe("cd app &&\nnpm test");
  });

  it("shows an Edit as its file and diff, and a Write as its file and content", () => {
    expect(cardDescription(claude("Edit", { file_path: "src/auth.ts", old_string: "const ttl = 3600;", new_string: "const ttl = 86400;" })))
      .toBe("src/auth.ts\n- const ttl = 3600;\n+ const ttl = 86400;");
    expect(cardDescription(claude("Write", { file_path: "notes.md", content: "# Notes" }))).toBe("notes.md\n# Notes");
    expect(cardDescription(claude("Read", { file_path: "notes.md" }))).toBe("notes.md");
  });

  it("shows an ACP request's title alone, and its whole input once it carries one", async () => {
    const asked: ApprovalRequest[] = [];
    const ask = acpPermission("Cursor", { ask: async (request) => { asked.push(request); return { reason: "timeout" }; } });
    const options = [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }, { optionId: "reject", name: "Reject", kind: "reject_once" as const }];
    await ask({ sessionId: "s", toolCall: { toolCallId: "call-1", title: "uname -a", kind: "execute" }, options });
    await ask({ sessionId: "s", toolCall: { toolCallId: "call-2", title: "Edit src/auth.ts", kind: "edit", rawInput: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } }, options });
    expect(asked.map((request) => request.extra)).toEqual([false, true]);
    expect(asked[0]?.detail).toBe("title: uname -a\nkind: execute");
    expect(cardDescription(asked[1]!)).toBe("title: Edit src/auth.ts\nkind: edit\nsrc/auth.ts\n- a\n+ b");
  });
});

describe("the card's description reads as text, not JSON", () => {
  it("draws an Edit as its file and a diff, a MultiEdit as a diff per edit", () => {
    expect(inputDetail({ file_path: "src/auth.ts", old_string: "const ttl = 3600;\nlog(id);", new_string: "const ttl = 86400;" }))
      .toBe("src/auth.ts\n- const ttl = 3600;\n- log(id);\n+ const ttl = 86400;");
    expect(inputDetail({ file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q", replace_all: true }] }))
      .toBe("a.ts\n- x\n+ y\n- p\n+ q\nreplace_all: true");
  });

  it("draws a Write as its file then the content, and anything else as one name: value line per field", () => {
    expect(inputDetail({ file_path: "notes.md", content: "# Notes\n\nfirst" })).toBe("notes.md\n# Notes\n\nfirst");
    expect(inputDetail({ command: "cd app &&\nnpm test", description: "Run the tests", timeout: 60000 }))
      .toBe("command: cd app &&\nnpm test\ndescription: Run the tests\ntimeout: 60000");
    expect(inputDetail({ url: "https://relayapp.im", headers: { accept: "text/html" }, tags: ["a", "b"] }))
      .toBe("url: https://relayapp.im\nheaders:\n  accept: text/html\ntags: a, b");
    expect(inputDetail({ command: "x" })).not.toContain("{");
  });
});

describe("Pi dialogs", () => {
  it("offers a confirm as Yes and No and a select as the extension's own options", async () => {
    const asked: ApprovalRequest[] = [];
    const pi = piApprovals({
      ask: async (request) => { asked.push(request); const choice = request.choices.at(-1); return choice ? { reason: "answered", choice, by: "ada" } : { reason: "timeout" }; },
      take: async () => false,
    });
    expect(await pi.dialog({ method: "confirm", title: "Clear session?", message: "All messages will be lost.", options: ["Yes", "No"], timeoutMs: 5000 })).toBe("No");
    expect(asked[0]).toMatchObject({ harness: "Pi", title: "Clear session?", summary: "All messages will be lost.", timeoutMs: 5000 });
    expect(asked[0]?.choices).toEqual([{ id: "Yes", label: "Yes", decision: "allow_once" }, { id: "No", label: "No", decision: "deny" }]);
    expect(await pi.dialog({ method: "select", title: "Dangerous command: rm -rf /tmp/x. Allow?", options: ["Yes", "No"] })).toBe("No");
    expect(asked[1]?.choices).toEqual([{ id: "Yes", label: "Yes", decision: "choice" }, { id: "No", label: "No", decision: "choice" }]);
  });
});
