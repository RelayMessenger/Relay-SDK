import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import type { MessageWebhookData, RelayWebhookEvent } from "@relaymessenger/sdk";
import { PiChannel, RELAY_TOOLS_LINE, type PiProcess } from "../src/index.js";
import { bubbles, SessionChannel } from "../src/session.js";
import { relayTools } from "../src/tools.js";

const fakeRelay = () => ({
  chats: { messages: { send: vi.fn().mockResolvedValue({}) }, startTyping: vi.fn(async () => {}), stopTyping: vi.fn(async () => {}) },
  messages: { addReaction: vi.fn().mockResolvedValue({ status: "accepted" }), retrieve: vi.fn() },
  attachments: { create: vi.fn().mockResolvedValue({ attachment_id: "att-1" }), upload: vi.fn().mockResolvedValue(undefined), retrieve: vi.fn() },
});
const inbound = (id: string, chat = "chat-1") => ({
  event_type: "message.received", event_id: `e-${id}`,
  data: { direction: "inbound", id, chat: { id: chat, is_group: false }, sender_handle: { handle: "alice", kind: "user" }, parts: [{ type: "text", value: "hi", reactions: null }] },
}) as unknown as RelayWebhookEvent & { data: MessageWebhookData };
const assistant = (...blocks: unknown[]): unknown => ({ role: "assistant", content: blocks });
const words = (text: string) => ({ type: "text", text });
const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: "c1", name, arguments: args });
const session = (relay: ReturnType<typeof fakeRelay>) => new SessionChannel({ sendUserMessage: vi.fn() }, { agentToken: "secret", relay: relay as unknown as Relay, isIdle: () => true });
const sentTexts = (relay: ReturnType<typeof fakeRelay>) =>
  relay.chats.messages.send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0]?.value, body.message.reply_to?.message_id]);

describe("message tool", () => {
  const tool = (relay: ReturnType<typeof fakeRelay>) => relayTools(relay as unknown as Relay, () => "chat-1", () => "msg-current").find((each) => each.name === "message")!;
  it("sends text to the current chat through the answer path, threaded when asked", async () => {
    const relay = fakeRelay();
    expect((await tool(relay).execute("call-1", { action: "send", text: "**On it**", reply_to: "msg-7" })).content[0]!.text).toBe("Sent.");
    await tool(relay).execute("call-2", { action: "send", text: "Done [[reply_to_current]]" });
    expect(relay.chats.messages.send.mock.calls).toEqual([
      ["chat-1", { message: { parts: [{ type: "text", value: "**On it**" }], idempotency_key: "pi-message-call-1-0", reply_to: { message_id: "msg-7" } } }],
      ["chat-1", { message: { parts: [{ type: "text", value: "Done" }], idempotency_key: "pi-message-call-2-0", reply_to: { message_id: "msg-current" } } }],
    ]);
  });
  it("reacts and sends a file, as the tools it replaces did", async () => {
    const relay = fakeRelay();
    await tool(relay).execute("c", { action: "react", emoji: "👍" });
    expect(relay.messages.addReaction).toHaveBeenCalledWith("msg-current", { operation: "add", type: "like" });
    const path = join(await mkdtemp(join(tmpdir(), "relay-pi-msg-")), "map.png");
    await writeFile(path, "png");
    expect((await tool(relay).execute("call-3", { action: "file", path, reply_to: "msg-7" })).content[0]!.text).toBe("Sent map.png.");
    expect(relay.chats.messages.send).toHaveBeenCalledWith("chat-1", { message: { parts: [{ type: "media", attachment_id: "att-1" }], idempotency_key: "pi-media-call-3", reply_to: { message_id: "msg-7" } } });
  });
  it("is the tool the prompt names, with no channel prefix", () => {
    expect(RELAY_TOOLS_LINE).toContain("message texts the person now");
    expect(RELAY_TOOLS_LINE).not.toContain("relay_react");
    expect(RELAY_TOOLS_LINE).not.toContain("relay_send_media");
  });
});

describe("session delivery", () => {
  it("sends no final text after the run texted with message", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    channel.ended([assistant(call("message", { action: "send", text: "on it" })), { role: "toolResult", toolName: "message", content: [], details: { sent: true } }, assistant(words("on it"))]);
    await channel.settled();
    expect(relay.chats.messages.send).not.toHaveBeenCalled();
  });
  it("sends every assistant text of the run in order, split at blank lines", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    channel.ended([assistant(words("I'll have the helper check."), call("subagent", { task: "x" })), { role: "toolResult", toolName: "subagent", content: [] }, assistant(words("**Found it.**\n\nOpens at 9."))]);
    await channel.settled();
    expect(sentTexts(relay)).toEqual([["chat-1", "I'll have the helper check.", undefined], ["chat-1", "**Found it.**", undefined], ["chat-1", "Opens at 9.", undefined]]);
    expect(relay.chats.messages.send.mock.calls.map(([, body]) => body.message.idempotency_key)).toEqual(["pi-e-m1-0", "pi-e-m1-p1-0", "pi-e-m1-p2-0"]);
  });
  it("threads a background result to the Message whose turn started it", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    channel.ended([assistant(call("subagent", { task: "x", async: true })), { role: "toolResult", toolName: "subagent", content: [], details: { asyncId: "run-42", asyncDir: "/tmp/async/run-42" } }, assistant(words("On it."))]);
    await channel.settled();
    await channel.receive(inbound("m2"));
    channel.ended([assistant(words("ok"))]);
    await channel.settled();
    relay.chats.messages.send.mockClear();
    channel.ended([{ role: "custom", customType: "subagent-notify", content: "Background task completed: **worker**\n\nRetention-managed async directory: /tmp/async/run-42" }, assistant(words("The store opens at 9.\n\nWant me to book it?"))]);
    await channel.settled();
    expect(sentTexts(relay)).toEqual([["chat-1", "The store opens at 9.", "m1"], ["chat-1", "Want me to book it?", "m1"]]);
  });
});

describe("channel delivery", () => {
  it("sends no final text when the Pi texted with message", async () => {
    const send = vi.fn().mockResolvedValue({});
    const event = inbound("m1");
    const relay = { chats: { messages: { send }, startTyping: vi.fn(async () => {}), stopTyping: vi.fn(async () => {}) }, websocket: { run: async (options: { onEvent: (event: RelayWebhookEvent) => Promise<void> }) => { await options.onEvent(event); } } } as unknown as Relay;
    async function* lines(): AsyncGenerator<string> {
      yield JSON.stringify({ id: "1", type: "response", success: true });
      yield JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "message", args: { action: "send", text: "on it" } });
      yield JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "message", result: { content: [], details: { sent: true } }, isError: false });
      yield JSON.stringify({ type: "agent_settled" });
      yield JSON.stringify({ id: "2", type: "response", success: true, data: { text: "on it" } });
    }
    const pi: PiProcess = { stdin: { write: vi.fn(), end: vi.fn() }, stdout: lines(), kill: vi.fn() };
    await new PiChannel({ agentToken: "secret", relay, spawnPi: () => pi }).run();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("review fixes", () => {
  it("still sends the channel answer when a message send did not go out", async () => {
    const send = vi.fn().mockResolvedValue({});
    const event = inbound("m1");
    const relay = { chats: { messages: { send }, startTyping: vi.fn(async () => {}), stopTyping: vi.fn(async () => {}) }, websocket: { run: async (options: { onEvent: (event: RelayWebhookEvent) => Promise<void> }) => { await options.onEvent(event); } } } as unknown as Relay;
    async function* lines(): AsyncGenerator<string> {
      yield JSON.stringify({ id: "1", type: "response", success: true });
      yield JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "message", args: { action: "send", text: "" } });
      yield JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "message", result: { content: [{ type: "text", text: "Write the text to send." }], details: {} }, isError: false });
      yield JSON.stringify({ type: "agent_settled" });
      yield JSON.stringify({ id: "2", type: "response", success: true, data: { text: "Here it is." } });
    }
    const pi: PiProcess = { stdin: { write: vi.fn(), end: vi.fn() }, stdout: lines(), kill: vi.fn() };
    await new PiChannel({ agentToken: "secret", relay, spawnPi: () => pi }).run();
    expect(send.mock.calls.map(([, body]) => body.message.parts[0].value)).toEqual(["Here it is."]);
  });
  it("still sends the answer when a message send did not go out", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    const sendTool = relayTools(relay as unknown as Relay, () => channel.chatId, () => channel.messageId).find((each) => each.name === "message")!;
    const attempt = await sendTool.execute("c1", { action: "send", text: "" });
    channel.ended([assistant(call("message", { action: "send", text: "" })), { role: "toolResult", toolName: "message", content: attempt.content, details: attempt.details }, assistant(words("Here it is."))]);
    await channel.settled();
    expect(sentTexts(relay)).toEqual([["chat-1", "Here it is.", undefined]]);
  });
  it("lets a background result's run text with message after the turn settled", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    channel.ended([{ role: "toolResult", toolName: "subagent", content: [], details: { asyncId: "run-42" } }, assistant(words("On it."))]);
    await channel.settled();
    relay.chats.messages.send.mockClear();
    const sendTool = relayTools(relay as unknown as Relay, () => channel.chatId, () => channel.messageId).find((each) => each.name === "message")!;
    expect((await sendTool.execute("c9", { action: "send", text: "Finished" })).content[0]!.text).toBe("Sent.");
    expect(sentTexts(relay)).toEqual([["chat-1", "Finished", undefined]]);
  });
  it("gives each background result from one Message its own keys", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    channel.ended([{ role: "toolResult", toolName: "subagent", content: [], details: { asyncId: "run-a" } }, { role: "toolResult", toolName: "subagent", content: [], details: { asyncId: "run-b" } }]);
    await channel.settled();
    for (const id of ["run-a", "run-b"]) {
      channel.ended([{ role: "custom", customType: "subagent-notify", content: `Background task completed: ${id}` }, assistant(words("Done."))]);
      await channel.settled();
    }
    const keys = relay.chats.messages.send.mock.calls.map(([, body]) => body.message.idempotency_key);
    expect(keys).toEqual(["pi-background-run-a-0-0", "pi-background-run-b-0-0"]);
  });
  it("threads an answer whose reply tag sits on its own line", async () => {
    const relay = fakeRelay();
    const channel = session(relay);
    await channel.receive(inbound("m1"));
    channel.ended([assistant(words("[[reply_to_current]]\n\nThe answer\n\nMore"))]);
    await channel.settled();
    expect(sentTexts(relay)).toEqual([["chat-1", "The answer", "m1"], ["chat-1", "More", undefined]]);
  });
  it("closes a fence only with the same character, at least as long", () => {
    expect(bubbles("````md\n```js\nx\n```\n\nstill code\n````\n\nafter")).toEqual(["````md\n```js\nx\n```\n\nstill code\n````", "after"]);
    expect(bubbles("~~~\na\n```\n\nb\n~~~")).toEqual(["~~~\na\n```\n\nb\n~~~"]);
  });
});
