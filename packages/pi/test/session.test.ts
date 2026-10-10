import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import type { MessagePartResponse, MessageWebhookData, RelayWebhookEvent } from "@relaymessenger/sdk";
import { agentToken, relaySettings } from "../src/native.js";
import { accepts, bubbles, NO_ANSWER, runAnswers, SessionChannel, sessionContent, type SessionContent } from "../src/session.js";
import { pcmFloats } from "../src/voice.js";

const media = (id: string, mime: string, filename: string): MessagePartResponse => ({ type: "media", id, url: `https://files.test/${id}`, filename, mime_type: mime, size_bytes: 3, reactions: null }) as MessagePartResponse;
const makeEvent = (id: string, parts: MessagePartResponse[], options: { chat?: string; handle?: string; group?: boolean } = {}): RelayWebhookEvent => ({
  event_type: "message.received", event_id: id, api_version: "v1", webhook_version: "2026-08-30", trace_id: "trace", agent_id: "agent",
  created_at: "2026-01-01T00:00:00Z",
  data: { direction: "inbound", id: `message-${id}`, chat: { id: options.chat ?? "chat", is_group: options.group ?? false } as never, sender_handle: { handle: options.handle ?? "alice", kind: "user" } as never, parts } as never,
});
const text = (value: string): MessagePartResponse => ({ type: "text", value, reactions: null }) as MessagePartResponse;
const assistant = (words: string): unknown => ({ role: "assistant", content: [{ type: "text", text: words }] });

function harness(options: { idle?: () => boolean; send?: ReturnType<typeof vi.fn>; senders?: string[] } = {}) {
  const send = options.send ?? vi.fn().mockResolvedValue({});
  const relay = { chats: { messages: { send } }, messages: { retrieve: vi.fn() }, attachments: { retrieve: vi.fn() } } as unknown as Relay;
  const sent: { content: SessionContent; options?: unknown }[] = [];
  const pi = {
    sendUserMessage: vi.fn((content: SessionContent, delivery?: unknown) => { sent.push({ content, options: delivery }); }),
    sendMessage: vi.fn((message: { content: SessionContent }, delivery: unknown) => { sent.push({ content: message.content, options: delivery }); }),
  };
  const channel = new SessionChannel(pi, { agentToken: "secret", relay, isIdle: options.idle ?? (() => true), ...(options.senders ? { senders: options.senders } : {}) });
  if (options.idle && !options.idle()) channel.started();
  return { channel, send, sent, pi };
}

describe("session content", () => {
  it("gives photos as image content, voice notes as words, and names other files", async () => {
    const download = vi.fn(async (part: MessagePartResponse & { type: "media" }) => Buffer.from(part.id));
    const transcribe = vi.fn().mockResolvedValue("call mom at six");
    const event = makeEvent("a", [text("look"), media("img", "image/png", "a.png"), media("voice", "audio/mp4", "note.m4a"), media("doc", "application/pdf", "b.pdf")]);
    const content = await sessionContent(event.data as MessageWebhookData, { download, transcribe });
    expect(content?.[1]).toEqual({ type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" });
    const words = (content?.[0] as { text: string }).text;
    // The Message alone: the Relay hint is in the system prompt, not here.
    expect(words).toBe("look\n\n[photo: a.png]\n[voice note, transcribed]: call mom at six\n[file: b.pdf (application/pdf), not opened]\n\n[Relay message id: message-a]\n[Relay chat: chat, from @alice]");
    expect(transcribe).toHaveBeenCalledWith(Buffer.from("voice"), "note.m4a");
  });
  it("names a voice note it cannot hear, and gives nothing for an empty Message", async () => {
    const download = vi.fn(async () => Buffer.from("x"));
    const content = await sessionContent(makeEvent("a", [media("v", "audio/mp4", "n.m4a")]).data as MessageWebhookData, { download });
    expect((content?.[0] as { text: string }).text).toContain("[voice note: n.m4a, could not be transcribed]");
    expect(await sessionContent(makeEvent("b", [text("  ")]).data as MessageWebhookData, { download })).toBeNull();
  });
  it("reads 16-bit PCM as floats", () => {
    const raw = Buffer.alloc(4); raw.writeInt16LE(16384, 0); raw.writeInt16LE(-32768, 2);
    expect(Array.from(pcmFloats(raw))).toEqual([0.5, -1]);
  });
  it("takes one-to-one Messages from the listed senders only", () => {
    expect(accepts(makeEvent("a", [text("hi")]))).toBe(true);
    expect(accepts(makeEvent("a", [text("hi")], { group: true }))).toBe(false);
    expect(accepts(makeEvent("a", [text("hi")], { handle: "Bob" }), ["@bob"])).toBe(true);
    expect(accepts(makeEvent("a", [text("hi")], { handle: "mallory" }), ["bob"])).toBe(false);
  });
  it("reads every assistant text of a run, in order", () => {
    expect(runAnswers([assistant("first"), { role: "user", content: "x" }, assistant(""), assistant("last")])).toEqual(["first", "last"]);
    expect(runAnswers([{ role: "assistant", content: [{ type: "toolCall" }] }])).toEqual([]);
    expect(runAnswers([{ role: "assistant", content: [], stopReason: "error" }])).toEqual([NO_ANSWER]);
  });
  it("splits an answer at blank lines, keeping a fenced block whole under its words", () => {
    expect(bubbles("**On it.**\n\nThe store opens at 9.\n\n\nSee you")).toEqual(["**On it.**", "The store opens at 9.", "See you"]);
    expect(bubbles("Pick one\n\n```buttons\nA\n\nB\n```\n\nLater")).toEqual(["Pick one\n\n```buttons\nA\n\nB\n```", "Later"]);
  });
});

describe("session channel", () => {
  it("answers each Message once, in the chat it came from, after the run settles", async () => {
    const { channel, send, sent } = harness();
    await channel.receive(makeEvent("a", [text("hello")], { chat: "one" }));
    await channel.receive(makeEvent("a", [text("hello")], { chat: "one" }));
    expect(sent).toHaveLength(1);
    channel.ended([assistant("hi there")]);
    expect(send).not.toHaveBeenCalled();
    await channel.settled();
    await channel.settled();
    expect(send.mock.calls).toEqual([["one", { message: { parts: [{ type: "text", value: "hi there" }], idempotency_key: "pi-a-0" } }]]);
  });
  it("sends the fallback line when a run fails with no words", async () => {
    const { channel, send } = harness();
    await channel.receive(makeEvent("a", [text("hello")]));
    channel.ended([{ role: "assistant", content: [], stopReason: "error" }]);
    await channel.settled();
    expect(send.mock.calls[0]?.[1].message.parts).toEqual([{ type: "text", value: NO_ANSWER }]);
  });
  it("holds a Message that arrives mid-run, then answers each in its own chat", async () => {
    const { channel, send, sent } = harness();
    await channel.receive(makeEvent("a", [text("first")], { chat: "one" }));
    await channel.receive(makeEvent("b", [text("second")], { chat: "two" }));
    expect(sent).toHaveLength(1);
    channel.ended([assistant("to one")]); await channel.settled();
    expect(sent).toHaveLength(2);
    channel.ended([assistant("to two")]); await channel.settled();
    expect(send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0].value])).toEqual([["one", "to one"], ["two", "to two"]]);
  });
  it("steers a run it did not start, and answers once when it settles", async () => {
    const { channel, send, sent } = harness({ idle: () => false });
    await channel.receive(makeEvent("a", [text("stop that")], { chat: "one" }));
    expect(sent).toEqual([{ content: expect.any(Array), options: { deliverAs: "steer" } }]);
    // A second Message from the same chat steers the same run.
    await channel.receive(makeEvent("b", [text("and this")], { chat: "one" }));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.options).toEqual({ deliverAs: "steer" });
    channel.ended([{ role: "user", content: "typed" }, { role: "user", content: sent[1]!.content }, assistant("stopped")]);
    await channel.settled();
    expect(send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0].value])).toEqual([["one", "stopped"]]);
    expect(sent).toHaveLength(2);
  });
  it("steers a Message that arrives mid-turn into the running turn, whose answer is the reply", async () => {
    let idle = true;
    const { channel, send, sent } = harness({ idle: () => idle });
    await channel.receive(makeEvent("a", [text("book a table")], { chat: "one" }));
    // Idle: the Message starts a normal run.
    expect(sent).toEqual([{ content: expect.any(Array), options: undefined }]);
    idle = false;
    channel.started();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("png"));
    await channel.receive(makeEvent("b", [text("make it 8pm"), media("img", "image/png", "menu.png")], { chat: "one" }));
    // Mid-turn: the same content a prompt gets, delivered as a steer, not held for a turn of its own.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ content: [{ type: "text", text: expect.stringContaining("make it 8pm") }, { type: "image", data: expect.any(String), mimeType: "image/png" }], options: { deliverAs: "steer" } });
    fetch.mockRestore();
    const [first, second] = sent.map((entry) => ({ role: "user", content: entry.content }));
    channel.ended([first, assistant("Looking."), second, assistant("Booked for 8pm.")]);
    idle = true;
    await channel.settled();
    expect(send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0].value, body.message.idempotency_key])).toEqual([["one", "Looking.", "pi-a-0"], ["one", "Booked for 8pm.", "pi-a-p1-0"]]);
    expect(sent).toHaveLength(2);
    // Nothing is left pending: the next Message starts its own run.
    await channel.receive(makeEvent("c", [text("thanks")], { chat: "one" }));
    expect(sent[2]?.options).toBeUndefined();
  });
  it("answers with every run before the settle, so a steer Pi ran as a continuation keeps the first answer", async () => {
    const { channel, send } = harness();
    await channel.receive(makeEvent("a", [text("first")], { chat: "one" }));
    channel.ended([assistant("one")]);
    channel.ended([{ role: "user", content: "steered" }, assistant("two")]);
    await channel.settled();
    expect(send.mock.calls.map(([, body]) => body.message.parts[0].value)).toEqual(["one", "two"]);
  });
  it("steers a Message from another chat into the running run, and a message with its chat_id answers it there", async () => {
    let idle = true;
    const { channel, send, sent } = harness({ idle: () => idle });
    await channel.receive(makeEvent("a", [text("first")], { chat: "one" }));
    idle = false;
    channel.started();
    await channel.receive(makeEvent("b", [text("other chat")], { chat: "two", handle: "bob" }));
    await channel.receive(makeEvent("c", [text("same chat, after")], { chat: "one" }));
    // Both steer the one run, whatever their chat, and each names its chat and sender.
    expect(sent.map((entry) => entry.options)).toEqual([undefined, { deliverAs: "steer" }, { deliverAs: "steer" }]);
    expect((sent[1]!.content[0] as { text: string }).text).toContain("[Relay chat: two, from @bob]");
    const [first, second, third] = sent.map((entry) => ({ role: "user", content: entry.content }));
    channel.ended([first, second, { role: "toolResult", toolName: "message", content: [], details: { sent: true, chat_id: "two" } }, third, assistant("to one")]);
    idle = true;
    await channel.settled();
    // The run's words go to the chat that started it; chat two was answered by the tool, so nothing runs again.
    expect(send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0].value])).toEqual([["one", "to one"]]);
    expect(sent).toHaveLength(3);
  });
  it("runs a steered Message from another chat again when the run never texted that chat", async () => {
    let idle = true;
    const { channel, send, sent } = harness({ idle: () => idle });
    await channel.receive(makeEvent("a", [text("first")], { chat: "one" }));
    idle = false;
    channel.started();
    await channel.receive(makeEvent("b", [text("other chat")], { chat: "two" }));
    channel.ended([{ role: "user", content: sent[0]!.content }, { role: "user", content: sent[1]!.content }, assistant("to one")]);
    idle = true;
    await channel.settled();
    // Chat one gets the run's words; chat two's Message is a turn of its own, answered in chat two.
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ content: sent[1]!.content, options: undefined });
    channel.ended([{ role: "user", content: sent[2]!.content }, assistant("to two")]);
    await channel.settled();
    expect(send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0].value, body.message.idempotency_key])).toEqual([["one", "to one", "pi-a-0"], ["two", "to two", "pi-b-0"]]);
  });
  it("starts an ordinary prompt when the previous run settled before the next Message arrives", async () => {
    let idle = true;
    const { channel, send, sent } = harness({ idle: () => idle });
    await channel.receive(makeEvent("a", [text("first")], { chat: "one" }));
    idle = false;
    channel.started();
    channel.ended([{ role: "user", content: sent[0]!.content }, assistant("one")]);
    idle = true;
    await channel.settled();
    await channel.receive(makeEvent("b", [text("second")], { chat: "one" }));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.options).toBeUndefined();
    channel.ended([{ role: "user", content: sent[1]!.content }, assistant("two")]);
    await channel.settled();
    expect(send.mock.calls.map(([, body]) => [body.message.parts[0].value, body.message.idempotency_key])).toEqual([["one", "pi-a-0"], ["two", "pi-b-0"]]);
  });
  it("holds compaction-only arrivals until Pi is idle, without starting or steering a run", async () => {
    let idle = true;
    const { channel, sent, pi } = harness({ idle: () => idle });
    idle = false;
    await channel.receive(makeEvent("compact", [text("after compaction")]));
    expect(sent).toEqual([]);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    idle = true;
    channel.next();
    expect(sent).toEqual([{ content: expect.any(Array), options: undefined }]);
  });
  it("sends a run no one prompted to the last chat, kept across restarts", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "relay-pi-last-")), "last.json");
    const send = vi.fn().mockResolvedValue({});
    const relay = { chats: { messages: { send } }, messages: { retrieve: vi.fn() }, attachments: { retrieve: vi.fn() } } as unknown as Relay;
    const pi = { sendUserMessage: vi.fn(), sendMessage: vi.fn() };
    const first = new SessionChannel(pi, { agentToken: "secret", relay, isIdle: () => true, lastChatFile: file });
    await first.receive(makeEvent("a", [text("start a helper")], { chat: "phone" }));
    first.ended([assistant("started")]); await first.settled();
    send.mockClear();
    const channel = new SessionChannel(pi, { agentToken: "secret", relay, isIdle: () => true, lastChatFile: file });
    channel.ended([{ role: "custom", customType: "subagent-notify", content: "done" }, assistant("the helper finished")]);
    await channel.settled();
    expect(send.mock.calls.map(([chat, body]) => [chat, body.message.parts[0].value])).toEqual([["phone", "the helper finished"]]);
    expect(send.mock.calls[0]?.[1].message.reply_to).toBeUndefined();
    // A typed turn stays on the desktop.
    channel.ended([{ role: "user", content: "typed" }, assistant("desk only")]);
    await channel.settled();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not answer a run it did not start", async () => {
    const { channel, send } = harness();
    channel.ended([assistant("typed at the box")]);
    await channel.settled();
    expect(send).not.toHaveBeenCalled();
  });
  it("clears the pending reply when sending fails, so the next Message still runs", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({});
    const { channel, sent } = harness({ send });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await channel.receive(makeEvent("a", [text("one")]));
    await channel.receive(makeEvent("b", [text("two")]));
    channel.ended([assistant("x")]); await channel.settled();
    expect(sent).toHaveLength(2);
    expect(error).toHaveBeenCalledWith("Relay: the answer was not sent: down");
    error.mockRestore();
  });
  it("skips senders not on the list", async () => {
    const { channel, sent } = harness({ senders: ["bob"] });
    await channel.receive(makeEvent("a", [text("hi")], { handle: "mallory" }));
    expect(sent).toHaveLength(0);
  });
});

describe("session settings", () => {
  it("reads the relay key and runs the token command, environment first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-pi-settings-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ relay: { mode: "session", agentTokenCommand: ["printf", "from-command"] } }));
    const settings = await relaySettings(dir);
    expect(settings.mode).toBe("session");
    const previous = process.env.RELAY_AGENT_TOKEN;
    delete process.env.RELAY_AGENT_TOKEN;
    expect(await agentToken(settings)).toBe("from-command");
    process.env.RELAY_AGENT_TOKEN = "from-env";
    expect(await agentToken(settings)).toBe("from-env");
    delete process.env.RELAY_AGENT_TOKEN;
    expect(await agentToken({ agentTokenCommand: ["false"] })).toBeUndefined();
    if (previous !== undefined) process.env.RELAY_AGENT_TOKEN = previous;
    expect(await relaySettings(join(dir, "missing"))).toEqual({});
  });
});
