import type { A2uiComponent, RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { acpPermission } from "./acp-bridge.js";
import {
  ANSWER_EVENT,
  OwnerApprovals,
  SEE_MORE_EVENT,
  approvalComponents,
  codeSpan,
  inputCard,
  inputDetail,
  noOwnerLine,
  piApprovals,
  seeMore,
  settledComponents,
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
  const sent: { chatId: string; parts: unknown[] }[] = [];
  const client = {
    me: { retrieve: async () => ({ ...AGENT, owner_people: owners }) },
    chats: {
      create: async (body: { from: string; to: string[]; message: { parts: unknown[] } }) => {
        created.push({ from: body.from, to: body.to, parts: body.message.parts });
        return { chat: { id: `chat-with-${body.to[0]}` } };
      },
      messages: {
        send: async (chatId: string, body: { message: { parts: unknown[] } }) => {
          sent.push({ chatId, parts: body.message.parts });
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

/** A tap on a card, as `message.received` carries it (Relay-Docs interactions/cards.mdx, "Receive a tap"). */
const tap = (surfaceId: string, from: { handle: string; kind: "user" | "agent" }, chatId: string, name = ANSWER_EVENT, choice = "proceed_once"): RelayWebhookEvent => ({
  event_id: `tap-${Math.random()}`,
  event_type: "message.received",
  data: {
    id: "tap-message",
    chat: { id: chatId },
    direction: "inbound",
    sender_handle: { handle: from.handle, kind: from.kind },
    parts: [{ type: "data", media_type: "application/a2ui+json", data: [
      { version: "v0.9.1", action: { name, surfaceId, sourceComponentId: "choice_0", timestamp: "2026-09-26T00:00:00Z", context: { choice } } },
    ] }],
  },
} as unknown as RelayWebhookEvent);

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

/** The components of the last update each card got, by chat. */
const updates = (sent: { chatId: string; parts: unknown[] }[]) => sent.flatMap(({ chatId, parts }) => {
  const data = (parts[0] as { data?: { updateComponents?: { components: A2uiComponent[] } }[] }).data ?? [];
  return data.flatMap((message) => message.updateComponents ? [{ chatId, components: message.updateComponents.components }] : []);
});

describe("owner approvals", () => {
  it("sends the card to each owner's own chat with the agent, and to nobody else", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined, surfaceId: () => "approval-1" });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 50 });
    await flush();
    expect(relay.created.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "coder.agent", to: ["ada"] },
      { from: "coder.agent", to: ["grace"] },
    ]);
    expect(relay.created[0]?.parts).toEqual([{ type: "data", media_type: "application/a2ui+json", data: [
      { version: "v0.9.1", createSurface: { surfaceId: "approval-1", catalogId: "https://relayapp.im/a2ui/catalog/v1" } },
      { version: "v0.9.1", updateComponents: { surfaceId: "approval-1", components: approvalComponents(REQUEST) } },
    ] }]);
    await asked;
  });

  it("takes an owner's tap as the answer and changes every owner's card to say so", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined, surfaceId: () => "approval-2" });
    const asked = approvals.ask(REQUEST);
    await flush();
    expect(await approvals.take(tap("approval-2", { handle: "grace", kind: "user" }, "chat-with-grace", ANSWER_EVENT, "proceed_always"))).toBe(true);
    expect(await asked).toEqual({ reason: "answered", by: "grace", choice: REQUEST.choices[1] });
    const outcome = updates(relay.sent);
    expect(outcome.map((update) => update.chatId)).toEqual(["chat-with-ada", "chat-with-grace"]);
    expect(outcome[0]?.components).toEqual([
      { id: "body", component: "Column", children: ["title", "summary", "outcome"] },
      { id: "outcome", component: "Text", text: "@grace allowed this for this session.", variant: "caption" },
    ]);
  });

  it("does not register a tap from anyone who is not an owner, sends nothing, and leaves the card to an owner", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined, surfaceId: () => "approval-3" });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 1_000 });
    await flush();
    expect(await approvals.take(tap("approval-3", { handle: "mallory", kind: "user" }, "chat-with-ada"))).toBe(true);
    expect(await approvals.take(tap("approval-3", { handle: "ada", kind: "agent" }, "chat-with-ada"))).toBe(true);
    await flush();
    // No message and no card change: a refusal is never a message sent on someone's behalf.
    expect(relay.sent).toEqual([]);
    // The card is still open: an owner's tap answers it.
    expect(await approvals.take(tap("approval-3", { handle: "ada", kind: "user" }, "chat-with-ada", ANSWER_EVENT, "cancel"))).toBe(true);
    expect(await asked).toEqual({ reason: "answered", by: "ada", choice: REQUEST.choices[2] });
    expect(relay.sent.every((send) => updates([send]).length === 1)).toBe(true);
  });

  it("denies and updates the card when nobody answers in time", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined, surfaceId: () => "approval-4" });
    expect(await approvals.ask({ ...REQUEST, timeoutMs: 20 })).toEqual({ reason: "timeout" });
    expect(updates(relay.sent)[0]?.components.at(-1)).toEqual({ id: "outcome", component: "Text", text: "Timed out, not approved.", variant: "caption" });
    // A late tap on the settled card is dropped, never a new turn.
    expect(await approvals.take(tap("approval-4", { handle: "ada", kind: "user" }, "chat-with-ada"))).toBe(true);
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

  it("leaves other cards' taps and ordinary messages to the bridge, and swallows See more", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined, surfaceId: () => "approval-5" });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 30 });
    await flush();
    expect(await approvals.take(tap("ride-1042", { handle: "ada", kind: "user" }, "chat-with-ada"))).toBe(false);
    expect(await approvals.take({ event_type: "message.received", event_id: "m", data: { parts: [{ type: "text", value: "hi" }] } } as unknown as RelayWebhookEvent)).toBe(false);
    expect(await approvals.take(tap("approval-5", { handle: "ada", kind: "user" }, "chat-with-ada", SEE_MORE_EVENT))).toBe(true);
    expect(await asked).toEqual({ reason: "timeout" });
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

  it("draws the command as code, whatever backticks it holds", () => {
    expect(codeSpan("rm -rf *_old")).toBe("`rm -rf *_old`");
    expect(codeSpan("echo `date`")).toBe("`` echo `date` ``");
  });
});

const CLAUDE = { harness: "Claude Code", choices: REQUEST.choices };
/** A Claude Code prompt as `claudePermission` asks it. */
const claude = (tool: string, input: Record<string, unknown>): ApprovalRequest => ({ ...CLAUDE, tool, ...inputCard(input) });
const ids = (components: A2uiComponent[]): string[] => components.map((component) => component.id);
const MORE = ["more", "more_button", "more_label", "more_sheet", "more_title", "more_text"];

describe("See more, only when the sheet shows what the card does not", () => {
  it("leaves a short command alone: no See more before or after the answer", () => {
    const request = claude("Bash", { command: "npm test -- --watch=false" });
    expect(seeMore(request)).toBe(false);
    expect(approvalComponents(request).filter((component) => MORE.includes(component.id))).toEqual([]);
    expect(approvalComponents(request).find((component) => component.id === "body")).toEqual({ id: "body", component: "Column", children: ["title", "summary", "answers"] });
    expect(settledComponents(request, { reason: "timeout" })[0]).toEqual({ id: "body", component: "Column", children: ["title", "summary", "outcome"] });
  });

  it("shows Bash's own description as a plain line under the command, with no See more", () => {
    const request = claude("Bash", { command: "npm test", description: "Run the tests" });
    expect(seeMore(request)).toBe(false);
    const components = approvalComponents(request);
    expect(ids(components)).not.toContain("more");
    expect(components.find((component) => component.id === "body")?.children).toEqual(["title", "summary", "note", "answers"]);
    expect(components.find((component) => component.id === "note")).toEqual({ id: "note", component: "Text", text: "Run the tests" });
  });

  it("offers See more when the command was cut, before and after the answer", () => {
    const long = claude("Bash", { command: `echo ${"a".repeat(495)}` });
    expect(seeMore(long)).toBe(true);
    expect(ids(approvalComponents(long))).toEqual(expect.arrayContaining(MORE));
    expect(settledComponents(long, { reason: "timeout" })[0]?.children).toEqual(["title", "summary", "more", "outcome"]);
    expect(seeMore(claude("Bash", { command: "cd app &&\nnpm test" }))).toBe(true);
  });

  it("offers See more for an Edit and for a Write, whose content the card does not show", () => {
    expect(seeMore(claude("Edit", { file_path: "src/auth.ts", old_string: "const ttl = 3600;", new_string: "const ttl = 86400;" }))).toBe(true);
    expect(seeMore(claude("Write", { file_path: "notes.md", content: "line\n".repeat(200) }))).toBe(true);
    expect(seeMore(claude("Read", { file_path: "notes.md" }))).toBe(false);
  });

  it("leaves an ACP request with only a title alone, and offers See more once it carries its input", async () => {
    const asked: ApprovalRequest[] = [];
    const ask = acpPermission("Cursor", { ask: async (request) => { asked.push(request); return { reason: "timeout" }; } });
    const options = [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }, { optionId: "reject", name: "Reject", kind: "reject_once" as const }];
    await ask({ sessionId: "s", toolCall: { toolCallId: "call-1", title: "uname -a", kind: "execute" }, options });
    await ask({ sessionId: "s", toolCall: { toolCallId: "call-2", title: "Edit src/auth.ts", kind: "edit", rawInput: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } }, options });
    expect(asked.map(seeMore)).toEqual([false, true]);
    expect(asked[0]?.detail).toBe("title: uname -a\nkind: execute");
    expect(asked[1]?.detail).toBe("title: Edit src/auth.ts\nkind: edit\nsrc/auth.ts\n- a\n+ b");
  });
});

describe("the See more sheet reads as text, not JSON", () => {
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

  it("shows every character of the sheet and the note, not read as Markdown", () => {
    const components = approvalComponents(claude("Edit", { file_path: "a.ts", old_string: "a * b", new_string: "**x_y** `z` [l] <b> & C:\\d ~s~" }));
    expect(components.find((component) => component.id === "more_text")?.text).toBe("a.ts\n- a \\* b\n+ \\*\\*x\\_y\\*\\* \\`z\\` \\[l\\] \\<b\\> \\& C:\\\\d \\~s\\~");
    expect(approvalComponents(claude("Bash", { command: "npm test", description: "Run __tests__" })).find((component) => component.id === "note")?.text).toBe("Run \\_\\_tests\\_\\_");
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
