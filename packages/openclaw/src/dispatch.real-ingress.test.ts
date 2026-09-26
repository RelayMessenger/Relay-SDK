import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PAYMENT_BLOCK_INSTRUCTION, PAYMENT_GUIDANCE, type RelayWebhookEvent } from "@relaymessenger/sdk";
import { dispatchRelayEvent } from "./dispatch.js";
import type { RelayIngressLifecycle } from "./ingress.js";
import { createRelayChatTurns, type RelayChatTurns } from "./turns.js";

// Deliberately use the installed OpenClaw resolver, route builder and identity
// authentication gates. Mocking admission concealed the stable-ID collision.
const approvedId = "01a07f76-4e51-70e1-8b12-a269a5b1774b";
const otherId = "00000000-0000-7000-8000-000000000099";
type EventOptions = {
  selection?: boolean;
  senderKind?: "user" | "agent";
  group?: boolean;
  mention?: string;
  replyToAgent?: boolean;
  replyChatId?: string;
  direction?: "inbound" | "outbound";
  owners?: string[];
  turns?: RelayChatTurns;
  invoke?: ReturnType<typeof vi.fn>;
  messageId?: string;
  lifecycle?: Partial<RelayIngressLifecycle>;
  parts?: unknown[];
};
async function dispatch(allowFrom: string[], contactId = approvedId, handle = "review_sender", options: EventOptions = {}) {
  const invoke = options.invoke ?? vi.fn(async () => undefined);
  const markAsRead = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const stopTyping = vi.fn(async () => undefined);
  const warn = vi.fn();
  const event: RelayWebhookEvent = {
    api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
    event_id: "00000000-0000-7000-8000-000000000002", created_at: "2026-09-08T00:00:00.000Z",
    trace_id: "offline-ingress-regression", agent_id: "00000000-0000-7000-8000-000000000001",
    data: {
      id: options.messageId ?? "00000000-0000-7000-8000-000000000003",
      chat: {
        id: "00000000-0000-7000-8000-000000000004", is_group: options.group ?? false,
        owner_handle: { id: "00000000-0000-7000-8000-000000000001", handle: "relay", kind: "agent", is_me: true },
      },
      direction: options.direction ?? "inbound",
      sender_handle: { id: contactId, handle, kind: options.senderKind ?? "user", display_name: "Review Sender", joined_at: "2026-09-08T00:00:00.000Z", image_url: null, subtitle: null, verified: false, is_contact: true },
      parts: options.parts ?? [{ type: "text", value: "@relay owned offline ingress test", ...(options.mention ? { mention: options.mention } : {}) }],
      ...(options.replyToAgent === undefined ? {} : { reply_to: { message_id: "00000000-0000-7000-8000-000000000010" } }),
    },
  } as RelayWebhookEvent;
  if (options.selection && event.event_type === "message.received") {
    event.data.parts = [{ type: "text", value: "• Research", reactions: null }, { type: "selection_response", selected_values: ["research"] }];
    event.data.reply_to = { message_id: "00000000-0000-7000-8000-000000000010", part_index: 1 };
  }
  await dispatchRelayEvent({
    event, lifecycle: (options.lifecycle ?? {}) as never,
    account: { accountId: "work", enabled: true, configured: true, token: "synthetic-unused", baseUrl: "https://api.staging.relayapp.im", allowFrom, config: {} },
    cfg: {},
    relay: {
      chats: { markAsRead, startTyping, stopTyping } as never,
      messages: { retrieve: vi.fn(async () => ({
        chat_id: options.replyChatId ?? "00000000-0000-7000-8000-000000000004",
        is_from_me: options.replyToAgent === true,
      })) } as never,
    },
    runtime: { channel: { inbound: { dispatch: invoke } } } as never, warn,
    owners: options.owners ?? [], turns: options.turns ?? createRelayChatTurns(),
  });
  return { invoke, markAsRead, startTyping, stopTyping, warn };
}

describe("Relay dispatch through real OpenClaw ingress", () => {
  it("keeps OpenClaw's databases in the throwaway state directory, never the real HOME", async () => {
    // test/isolated-home.ts: the real ingress path opens OpenClaw's state and
    // agent databases, which must never be the owner's ~/.openclaw.
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
    expect(stateDir.startsWith(tmpdir()) || stateDir.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(homedir()).toBe(dirname(stateDir));
    await dispatch([approvedId]);
    expect(existsSync(join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
  });

  it("admits the explicitly allowed stable Contact ID despite the dangerous username alias", async () => {
    const result = await dispatch([approvedId]);
    expect(result.invoke).toHaveBeenCalledOnce();
    expect(result.markAsRead).toHaveBeenCalledOnce();
    expect(result.stopTyping).toHaveBeenCalledOnce();
    expect(result.warn).not.toHaveBeenCalled();
  });
  it("keeps a changed username authorized only through its same approved stable ID", async () => {
    expect((await dispatch([approvedId], approvedId, "renamed_sender")).invoke).toHaveBeenCalledOnce();
  });
  it("denies a different stable ID, even if its username is the approved ID string", async () => {
    const result = await dispatch([approvedId], otherId, approvedId);
    expect(result.invoke).not.toHaveBeenCalled();
    expect(result.markAsRead).not.toHaveBeenCalled();
    expect(result.startTyping).not.toHaveBeenCalled();
    expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("dm_policy_not_allowlisted"));
  });
  it("does not elevate a username-only allowlist to an authenticated stable-ID grant", async () => {
    const result = await dispatch(["review_sender"]);
    expect(result.invoke).not.toHaveBeenCalled();
    expect(result.markAsRead).not.toHaveBeenCalled();
    expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("dm_policy_not_allowlisted"));
  });
  it("admits a stable ID among multiple entries without alias shadowing", async () => {
    expect((await dispatch([otherId, approvedId, "untrusted_alias"])).invoke).toHaveBeenCalledOnce();
  });
  it("answers every sender only with OpenClaw's explicit open spelling, allowFrom [\"*\"]", async () => {
    expect((await dispatch(["*"], otherId)).invoke).toHaveBeenCalledOnce();
    expect((await dispatch(["*"], otherId, "peer_agent", { senderKind: "agent" })).invoke).toHaveBeenCalledOnce();
  });
  it("answers only the owner by default, and refuses another owner's agent before any turn", async () => {
    // Owner ruling 2026-09-25: a connected agent answers only its owner by
    // default. With allowFrom unset the owners from GET /v1/me are the list.
    const owner = await dispatch([], approvedId, "review_sender", { owners: [approvedId] });
    expect(owner.invoke).toHaveBeenCalledOnce();
    const stranger = await dispatch([], otherId, "peer_agent", { senderKind: "agent", owners: [approvedId] });
    expect(stranger.invoke).not.toHaveBeenCalled();
    expect(stranger.markAsRead).not.toHaveBeenCalled();
    expect(stranger.startTyping).not.toHaveBeenCalled();
    expect(stranger.warn).toHaveBeenCalledWith(expect.stringContaining("dm_policy_not_allowlisted"));
  });
  it("answers no one when allowFrom is unset and Relay names no owner", async () => {
    const result = await dispatch([], approvedId);
    expect(result.invoke).not.toHaveBeenCalled();
    expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("dm_policy_not_allowlisted"));
  });
  it("lets a configured allowFrom replace the owners", async () => {
    expect((await dispatch([otherId], approvedId, "review_sender", { owners: [approvedId] })).invoke).not.toHaveBeenCalled();
    expect((await dispatch([otherId], otherId, "review_sender", { owners: [approvedId] })).invoke).toHaveBeenCalledOnce();
  });
  it("admits an explicitly allowed agent Contact through the real identity gate", async () => {
    const result = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent" });
    expect(result.invoke).toHaveBeenCalledOnce();
    expect(result.markAsRead).toHaveBeenCalledOnce();
    expect(result.stopTyping).toHaveBeenCalledOnce();
    expect(result.warn).not.toHaveBeenCalled();
  });
  it("does not bypass stable-ID authorization for an agent sender", async () => {
    for (const [allowFrom, contactId, handle] of [
      [[approvedId], otherId, approvedId],
      [["peer_agent"], approvedId, "peer_agent"],
    ] as const) {
      const result = await dispatch([...allowFrom], contactId, handle, { senderKind: "agent" });
      expect(result.invoke).not.toHaveBeenCalled();
      expect(result.markAsRead).not.toHaveBeenCalled();
      expect(result.startTyping).not.toHaveBeenCalled();
      expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("dm_policy_not_allowlisted"));
    }
  });
  it("admits a group agent Message only with canonical mention activation", async () => {
    const result = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", group: true, mention: "relay" });
    expect(result.invoke).toHaveBeenCalledOnce();
  });
  it("keeps unmentioned and visibly mentioned agent group traffic silent", async () => {
    const result = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", group: true });
    expect(result.invoke).not.toHaveBeenCalled();
    expect(result.markAsRead).not.toHaveBeenCalled();
  });
  it("keeps the group sender allowlist even when an agent canonically mentions this agent", async () => {
    const result = await dispatch([approvedId], otherId, "unapproved_agent", { senderKind: "agent", group: true, mention: "relay" });
    expect(result.invoke).not.toHaveBeenCalled();
    expect(result.startTyping).not.toHaveBeenCalled();
  });
  it("admits an agent group reply to this agent in the same Chat", async () => {
    const result = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", group: true, replyToAgent: true });
    expect(result.invoke).toHaveBeenCalledOnce();
  });
  it("rejects agent group replies to another sender or a different Chat", async () => {
    for (const options of [
      { replyToAgent: false },
      { replyToAgent: true, replyChatId: "00000000-0000-7000-8000-000000000099" },
    ]) {
      const result = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", group: true, ...options });
      expect(result.invoke).not.toHaveBeenCalled();
      expect(result.markAsRead).not.toHaveBeenCalled();
    }
  });
  it("never invokes on an outbound agent self echo", async () => {
    const result = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", direction: "outbound" });
    expect(result.invoke).not.toHaveBeenCalled();
  });
});


it("forwards selection data and native authoring guidance to the admitted OpenClaw turn", async () => {
  const result = await dispatch([approvedId], approvedId, "review_sender", { selection: true });
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({
    ctxPayload: expect.objectContaining({
      BodyForAgent: expect.stringContaining('"selected_values":["research"]'),
      RawBody: "• Research",
    }),
  }));
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({
    ctxPayload: expect.objectContaining({ BodyForAgent: expect.stringContaining("portable text remains bullets") }),
  }));
});

it("teaches the admitted OpenClaw turn how and when to send a payment", async () => {
  const result = await dispatch([approvedId], approvedId, "review_sender");
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({
    ctxPayload: expect.objectContaining({ BodyForAgent: expect.stringContaining(PAYMENT_BLOCK_INSTRUCTION) }),
  }));
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({
    ctxPayload: expect.objectContaining({ BodyForAgent: expect.stringContaining(PAYMENT_GUIDANCE) }),
  }));
});


it("keeps ordered rich parts in model context, not executable command input", async () => {
  const result = await dispatch([approvedId], approvedId, "review_sender", { selection: true });
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({
    ctxPayload: expect.objectContaining({
      BodyForAgent: expect.stringContaining('"type":"selection_response"'),
      CommandBody: "• Research",
      RawBody: "• Research",
    }),
  }));
});

describe("Relay answers each of another agent's overlapping Messages, naming it", () => {
  const first = "00000000-0000-7000-8000-000000000031";
  const second = "00000000-0000-7000-8000-000000000032";

  function heldTurns() {
    const releases: Array<() => void> = [];
    const invoke = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    return { invoke, releases };
  }

  it("holds a second agent Message until the running turn ends, then gives it its own turn", async () => {
    // OpenClaw steers a mid-turn Message into the running turn by default
    // (docs/concepts/queue.md), whose answer names the first Message only.
    const turns = createRelayChatTurns();
    const { invoke, releases } = heldTurns();
    const onDeferred = vi.fn();
    const one = dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", turns, invoke, messageId: first });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const two = dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", turns, invoke, messageId: second, lifecycle: { onDeferred } });
    await vi.waitFor(() => expect(onDeferred).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(invoke).toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    releases[1]!();
    await Promise.all([one, two]);
    const calls = invoke.mock.calls as unknown as Array<[{ ctxPayload: { MessageSid?: string }; delivery: { durable: { replyToId: string | null } } }]>;
    expect(calls.map(([call]) => call.delivery.durable.replyToId)).toEqual([first, second]);
  });

  it("leaves a person's Message to OpenClaw's own queue", async () => {
    const turns = createRelayChatTurns();
    const { invoke, releases } = heldTurns();
    const one = dispatch([approvedId], approvedId, "review_sender", { turns, invoke, messageId: first });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const two = dispatch([approvedId], approvedId, "review_sender", { turns, invoke, messageId: second });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    releases.forEach((release) => release());
    await Promise.all([one, two]);
  });

  it("names the agent's Message in every answer, and never a person's", async () => {
    const agent = await dispatch([approvedId], approvedId, "peer_agent", { senderKind: "agent", messageId: first });
    const [agentCall] = agent.invoke.mock.calls[0] as unknown as [{ delivery: { durable: { replyToId: string | null }; preparePayload?: (payload: object) => { replyToId?: string } } }];
    expect(agentCall.delivery.durable.replyToId).toBe(first);
    expect(agentCall.delivery.preparePayload?.({ text: "answer" })).toEqual({ text: "answer", replyToId: first });
    // A reply target the model chose itself stands.
    expect(agentCall.delivery.preparePayload?.({ text: "answer", replyToId: "chosen" })).toEqual({ text: "answer", replyToId: "chosen" });
    const person = await dispatch([approvedId], approvedId, "review_sender", { messageId: first });
    const [personCall] = person.invoke.mock.calls[0] as unknown as [{ delivery: { durable: { replyToId: string | null }; preparePayload?: unknown } }];
    expect(personCall.delivery.durable.replyToId).toBeNull();
    expect(personCall.delivery.preparePayload).toBeUndefined();
  });

  it("removes OpenClaw's implicit reply to an agent Message that opens with buttons", async () => {
    const result = await dispatch([approvedId], approvedId, "peer_agent", {
      senderKind: "agent",
      messageId: first,
      parts: [{ type: "buttons", items: [{ label: "Yes" }], reactions: null }, { type: "text", value: "Go?", reactions: null }],
    });
    const [call] = result.invoke.mock.calls[0] as unknown as [{ delivery: { durable: { replyToId: string | null }; preparePayload: (payload: object) => object } }];
    expect(call.delivery.durable.replyToId).toBeNull();
    expect(call.delivery.preparePayload({ text: "answer", replyToId: first })).toEqual({ text: "answer" });
  });
});
