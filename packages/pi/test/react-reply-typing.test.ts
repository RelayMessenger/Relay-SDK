import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Relay, { RelayAPIError } from "@relaymessenger/sdk";
import type { MessageWebhookData, RelayWebhookEvent } from "@relaymessenger/sdk";
import { PiChannel, replyTag, sendAnswer, type PiProcess } from "../src/index.js";
import { SessionChannel } from "../src/session.js";
import { relayReaction, relayTools } from "../src/tools.js";

const fakeRelay = () => {
  const order: string[] = [];
  const relay = {
    chats: {
      messages: { send: vi.fn(async () => { order.push("send"); return {}; }) },
      startTyping: vi.fn(async () => { order.push("start"); }),
      stopTyping: vi.fn(async () => { order.push("stop"); }),
    },
    messages: { addReaction: vi.fn().mockResolvedValue({ status: "accepted" }), retrieve: vi.fn() },
    attachments: { create: vi.fn().mockResolvedValue({ attachment_id: "att-1" }), upload: vi.fn().mockResolvedValue(undefined) },
  };
  return { relay, order };
};

const inbound = (id: string, kind: "user" | "agent" = "user") => ({
  event_type: "message.received", event_id: `e-${id}`,
  data: { direction: "inbound", id, chat: { id: "chat-1", is_group: false }, sender_handle: { handle: "alice", kind }, parts: [{ type: "text", value: "hi", reactions: null }] },
}) as unknown as RelayWebhookEvent & { data: MessageWebhookData };

describe("relay_react", () => {
  const tools = (relay: unknown, current: string | null = "msg-current") =>
    Object.fromEntries(relayTools(relay as Relay, () => "chat-1", () => current ?? undefined).map((tool) => [tool.name, tool]));
  it("reacts to the Message being answered by default, as a tapback", async () => {
    const { relay } = fakeRelay();
    expect((await tools(relay).relay_react!.execute("c", { emoji: "👍" })).content[0]!.text).toBe("Reacted 👍.");
    expect(relay.messages.addReaction).toHaveBeenCalledWith("msg-current", { operation: "add", type: "like" });
  });
  it("reacts to a named Message with a custom emoji, and can take it back", async () => {
    const { relay } = fakeRelay();
    await tools(relay).relay_react!.execute("c", { emoji: "🎉", message_id: "msg-other" });
    await tools(relay).relay_react!.execute("c", { emoji: "🎉", message_id: "msg-other", remove: true });
    expect(relay.messages.addReaction.mock.calls).toEqual([
      ["msg-other", { operation: "add", type: "custom", custom_emoji: "🎉" }],
      ["msg-other", { operation: "remove", type: "custom", custom_emoji: "🎉" }],
    ]);
  });
  it("asks for a message id when nothing is being answered", async () => {
    const { relay } = fakeRelay();
    expect((await tools(relay, null).relay_react!.execute("c", { emoji: "❤️" })).content[0]!.text).toContain("name one with message_id");
    expect(relay.messages.addReaction).not.toHaveBeenCalled();
  });
  it("gives the model Relay's refusal", async () => {
    const { relay } = fakeRelay();
    relay.messages.addReaction.mockRejectedValueOnce(new RelayAPIError("That part takes no reactions.", { status: 422 }));
    expect((await tools(relay).relay_react!.execute("c", { emoji: "❤️" })).content[0]!.text).toBe("Relay refused: That part takes no reactions.");
  });
  it("maps every tapback emoji and word", () => {
    expect(["❤️", "👍", "👎", "😂", "‼️", "❓", "Laugh"].map((emoji) => relayReaction(emoji).type))
      .toEqual(["love", "like", "dislike", "laugh", "emphasize", "question", "laugh"]);
  });
});

describe("replies to a specific Message", () => {
  it("threads relay_send_media to the Message it names", async () => {
    const { relay } = fakeRelay();
    const path = join(await mkdtemp(join(tmpdir(), "relay-pi-")), "a.pdf");
    await writeFile(path, Buffer.from("pdf"));
    const media = relayTools(relay as unknown as Relay, () => "chat-1").find((tool) => tool.name === "relay_send_media")!;
    await media.execute("call-1", { path, reply_to: "msg-7" });
    expect(relay.chats.messages.send).toHaveBeenCalledWith("chat-1", { message: {
      parts: [{ type: "media", attachment_id: "att-1" }], idempotency_key: "pi-media-call-1", reply_to: { message_id: "msg-7" },
    } });
  });
  it("reads and removes a reply tag", () => {
    expect(replyTag("[[reply_to_current]] Sure.")).toEqual({ answer: "Sure.", replyTo: "current" });
    expect(replyTag("On it [[ reply_to: msg-9 ]]")).toEqual({ answer: "On it", replyTo: "msg-9" });
    expect(replyTag("No tag")).toEqual({ answer: "No tag" });
  });
  it("threads the answer to the Message a tag names, and to the current one for reply_to_current", async () => {
    const { relay } = fakeRelay();
    const { data } = inbound("msg-1");
    await sendAnswer(relay as unknown as Relay, data, "k", "[[reply_to:msg-0]] That one.");
    await sendAnswer(relay as unknown as Relay, data, "j", "[[reply_to_current]]\nThis one.");
    expect(relay.chats.messages.send.mock.calls).toEqual([
      ["chat-1", { message: { parts: [{ type: "text", value: "That one." }], idempotency_key: "k-0", reply_to: { message_id: "msg-0" } } }],
      ["chat-1", { message: { parts: [{ type: "text", value: "This one." }], idempotency_key: "j-0", reply_to: { message_id: "msg-1" } } }],
    ]);
  });
  it("gives the model the id of the Message it answers", async () => {
    const { relay } = fakeRelay();
    const sendUserMessage = vi.fn();
    const channel = new SessionChannel({ sendUserMessage }, { agentToken: "t", relay: relay as unknown as Relay, isIdle: () => true });
    await channel.receive(inbound("msg-42"));
    expect(sendUserMessage.mock.calls[0]![0][0].text).toContain("[Relay message id: msg-42]");
    expect(channel.messageId).toBe("msg-42");
  });
});

describe("typing indicator", () => {
  it("types while a session turn runs and stops after the answer is sent", async () => {
    const { relay, order } = fakeRelay();
    const channel = new SessionChannel({ sendUserMessage: vi.fn() }, { agentToken: "t", relay: relay as unknown as Relay, isIdle: () => true });
    await channel.receive(inbound("msg-1"));
    expect(relay.chats.startTyping).toHaveBeenCalledWith("chat-1");
    expect(relay.chats.stopTyping).not.toHaveBeenCalled();
    channel.ended([{ role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" }]);
    await channel.settled();
    expect(order).toEqual(["start", "send", "stop"]);
    expect(relay.chats.stopTyping).toHaveBeenCalledWith("chat-1");
  });
  it("types for a Message that steers a busy run, gives it the Message id, and stops after the steered answer", async () => {
    const { relay, order } = fakeRelay();
    const sendUserMessage = vi.fn();
    const channel = new SessionChannel({ sendUserMessage }, { agentToken: "t", relay: relay as unknown as Relay, isIdle: () => false });
    await channel.receive(inbound("msg-5"));
    expect(sendUserMessage).toHaveBeenCalledWith(expect.any(Array), { deliverAs: "steer" });
    expect(sendUserMessage.mock.calls[0]![0][0].text).toContain("[Relay message id: msg-5]");
    expect(channel.messageId).toBe("msg-5");
    channel.ended([{ role: "user", content: "typed" }, { role: "assistant", content: [{ type: "text", text: "[[reply_to_current]] steered" }], stopReason: "stop" }]);
    await channel.settled();
    expect(order).toEqual(["start", "send", "stop"]);
    expect(relay.chats.messages.send).toHaveBeenCalledWith("chat-1", { message: { parts: [{ type: "text", value: "steered" }], idempotency_key: "pi-e-msg-5-0", reply_to: { message_id: "msg-5" } } });
  });
  it("types while an RPC Pi works, stops after the answer, and a typing failure does not stop the answer", async () => {
    const { relay, order } = fakeRelay();
    relay.chats.startTyping.mockRejectedValueOnce(new Error("offline"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const event = inbound("msg-1");
    async function* lines(): AsyncGenerator<string> {
      yield JSON.stringify({ id: "1", type: "response", success: true });
      yield JSON.stringify({ type: "agent_settled" });
      yield JSON.stringify({ id: "2", type: "response", success: true, data: { text: "hello" } });
    }
    const pi: PiProcess = { stdin: { write: vi.fn(), end: vi.fn() }, stdout: lines(), kill: vi.fn() };
    const withSocket = { ...relay, websocket: { run: async (options: { onEvent: (event: RelayWebhookEvent) => Promise<void> }) => { await options.onEvent(event); } } };
    await new PiChannel({ agentToken: "t", relay: withSocket as unknown as Relay, spawnPi: () => pi }).run();
    expect(order).toEqual(["send", "stop"]);
    expect(relay.chats.startTyping).toHaveBeenCalledWith("chat-1");
    expect(error).toHaveBeenCalledWith("Relay: typing indicator failed: offline");
    error.mockRestore();
  });
});
