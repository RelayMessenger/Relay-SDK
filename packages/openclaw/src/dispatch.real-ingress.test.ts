import { describe, expect, it, vi } from "vitest";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { dispatchRelayEvent } from "./dispatch.js";

// Deliberately use the installed OpenClaw resolver, route builder and identity
// authentication gates. Mocking admission concealed the stable-ID collision.
const approvedId = "01a07f76-4e51-70e1-8b12-a269a5b1774b";
const otherId = "00000000-0000-7000-8000-000000000099";
type EventOptions = {
  senderKind?: "user" | "agent";
  group?: boolean;
  mention?: string;
  replyToAgent?: boolean;
  replyChatId?: string;
  direction?: "inbound" | "outbound";
};
async function dispatch(allowFrom: string[], contactId = approvedId, handle = "review_sender", options: EventOptions = {}) {
  const invoke = vi.fn(async () => undefined);
  const markAsRead = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const stopTyping = vi.fn(async () => undefined);
  const warn = vi.fn();
  const event: RelayWebhookEvent = {
    api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
    event_id: "00000000-0000-7000-8000-000000000002", created_at: "2026-09-08T00:00:00.000Z",
    trace_id: "offline-ingress-regression", agent_id: "00000000-0000-7000-8000-000000000001",
    data: {
      id: "00000000-0000-7000-8000-000000000003",
      chat: {
        id: "00000000-0000-7000-8000-000000000004", is_group: options.group ?? false,
        owner_handle: { id: "00000000-0000-7000-8000-000000000001", handle: "relay", kind: "agent", is_me: true },
      },
      direction: options.direction ?? "inbound",
      sender_handle: { id: contactId, handle, kind: options.senderKind ?? "user", display_name: "Review Sender", joined_at: "2026-09-08T00:00:00.000Z", image_url: null, about: null, verified: false },
      parts: [{ type: "text", value: "@relay owned offline ingress test", ...(options.mention ? { mention: options.mention } : {}) }],
      ...(options.replyToAgent === undefined ? {} : { reply_to: { message_id: "00000000-0000-7000-8000-000000000010" } }),
    },
  } as RelayWebhookEvent;
  await dispatchRelayEvent({
    event, lifecycle: {} as never,
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
  });
  return { invoke, markAsRead, startTyping, stopTyping, warn };
}

describe("Relay dispatch through real OpenClaw ingress", () => {
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
  it.each([["*"], []])("retains existing wildcard/open policy for %j", async (...entries) => {
    const allowFrom = entries as string[];
    expect((await dispatch(allowFrom, otherId)).invoke).toHaveBeenCalledOnce();
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
