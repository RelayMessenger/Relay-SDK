import type { A2uiComponent, RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import {
  ANSWER_EVENT,
  NOT_AUTHORIZED,
  OwnerApprovals,
  SEE_MORE_EVENT,
  approvalComponents,
  codeSpan,
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
  detail: "{\n  \"command\": \"uname -a\"\n}",
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
      { id: "body", component: "Column", children: ["title", "summary", "more", "outcome"] },
      { id: "outcome", component: "Text", text: "@grace allowed this for this session.", variant: "caption" },
    ]);
  });

  it("refuses a tap from anyone who is not an owner, says Not authorized., and keeps waiting", async () => {
    const relay = fakeRelay();
    const said: string[] = [];
    const approvals = new OwnerApprovals({ client: relay.client, say: (line) => said.push(line), surfaceId: () => "approval-3" });
    const asked = approvals.ask({ ...REQUEST, timeoutMs: 200 });
    await flush();
    expect(await approvals.take(tap("approval-3", { handle: "mallory", kind: "user" }, "chat-with-ada"))).toBe(true);
    expect(await approvals.take(tap("approval-3", { handle: "ada", kind: "agent" }, "chat-with-ada"))).toBe(true);
    expect(relay.sent.filter((send) => JSON.stringify(send.parts) === JSON.stringify([{ type: "text", value: NOT_AUTHORIZED }])))
      .toHaveLength(2);
    expect(said.some((line) => line.includes("@mallory is not an owner"))).toBe(true);
    // Nothing the stranger did answered it: it runs out, not approved.
    expect(await asked).toEqual({ reason: "timeout" });
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
