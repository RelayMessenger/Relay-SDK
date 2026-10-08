import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import type { MessagePartResponse, MessageWebhookData, RelayWebhookEvent } from "@relaymessenger/sdk";
import { agentToken, relaySettings } from "../src/native.js";
import { accepts, lastAnswer, NO_ANSWER, SessionChannel, sessionContent, type SessionContent } from "../src/session.js";
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
  const pi = { sendUserMessage: vi.fn((content: SessionContent, delivery?: unknown) => { sent.push({ content, options: delivery }); }) };
  const channel = new SessionChannel(pi, { agentToken: "secret", relay, isIdle: options.idle ?? (() => true), ...(options.senders ? { senders: options.senders } : {}) });
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
    expect(words).toContain("look\n\n[photo: a.png]\n[voice note, transcribed]: call mom at six\n[file: b.pdf (application/pdf), not opened]");
    expect(words).toContain("Relay sends that answer to the chat for you");
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
  it("reads the last assistant words of a run", () => {
    expect(lastAnswer([assistant("first"), { role: "user", content: "x" }, assistant("last")])).toBe("last");
    expect(lastAnswer([{ role: "assistant", content: [{ type: "toolCall" }] }])).toBeUndefined();
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
  it("waits while the session is busy with something else", async () => {
    let idle = false;
    const { channel, sent } = harness({ idle: () => idle });
    await channel.receive(makeEvent("a", [text("hello")]));
    expect(sent).toHaveLength(0);
    // The person's own run settles; Relay's Message goes next.
    idle = true; await channel.settled();
    expect(sent).toHaveLength(1);
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
