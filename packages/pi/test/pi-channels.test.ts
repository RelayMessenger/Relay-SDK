import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type Relay from "@relaymessenger/sdk";
import type { MessagePartResponse, RelayWebhookEvent } from "@relaymessenger/sdk";
import relayPiExtension, { piChannelsRelaySettings } from "../src/native.js";
import { registerRelayAdapter, relayChannelAdapter, RELAY_ADAPTER } from "../src/pi-channels.js";
import { piChannelsHost } from "./pi-channels-host.js";

const text = (value: string): MessagePartResponse => ({ type: "text", value, reactions: null }) as MessagePartResponse;
const media = (id: string, mime: string, filename: string): MessagePartResponse => ({ type: "media", id, url: `https://files.test/${id}`, filename, mime_type: mime, size_bytes: 3, reactions: null }) as MessagePartResponse;
const event = (id: string, parts: MessagePartResponse[], options: { chat?: string; handle?: string; direction?: string } = {}): RelayWebhookEvent => ({
  event_type: "message.received", event_id: id, api_version: "v1", webhook_version: "2026-08-30", trace_id: "trace", agent_id: "agent",
  created_at: "2026-01-01T00:00:00Z",
  data: { direction: options.direction ?? "inbound", id: `message-${id}`, chat: { id: options.chat ?? "chat_1", is_group: false } as never, sender_handle: { handle: options.handle ?? "alice", kind: "user" } as never, parts } as never,
});

/** A Relay client whose WebSocket hands the test each event, and whose sends are recorded. */
const fakeRelay = () => {
  let deliver: ((event: RelayWebhookEvent) => Promise<void>) | undefined;
  const send = vi.fn().mockResolvedValue({});
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const run = vi.fn((options: { onEvent: (event: RelayWebhookEvent) => Promise<void>; signal?: AbortSignal }) => {
    deliver = options.onEvent;
    return new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  });
  const relay = { chats: { messages: { send }, startTyping }, messages: { retrieve: vi.fn() }, attachments: { retrieve: vi.fn() }, websocket: { run } } as unknown as Relay;
  return { relay, send, startTyping, run, deliver: (value: RelayWebhookEvent) => deliver!(value) };
};

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("registration with pi-channels", () => {
  it("registers a bidirectional relay adapter through channel:register, and starts it", () => {
    const events = createEventBus();
    const host = piChannelsHost(events);
    const { relay, run } = fakeRelay();
    expect(registerRelayAdapter(events, () => relayChannelAdapter({ relay }))).toBe(true);
    expect(host.adapters.get(RELAY_ADAPTER)?.direction).toBe("bidirectional");
    expect(run).toHaveBeenCalledOnce();
  });
  it("does nothing without pi-channels, and does not register twice", () => {
    const factory = vi.fn(() => relayChannelAdapter({ relay: fakeRelay().relay }));
    expect(registerRelayAdapter(createEventBus(), factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    const events = createEventBus();
    piChannelsHost(events);
    expect(registerRelayAdapter(events, factory)).toBe(true);
    expect(registerRelayAdapter(events, factory)).toBe(false);
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe("sending", () => {
  it("sends a channel:send message to the Relay chat named as recipient", async () => {
    const events = createEventBus();
    piChannelsHost(events, { routes: { me: { adapter: "relay", recipient: "chat_9" } } });
    const { relay, send } = fakeRelay();
    registerRelayAdapter(events, () => relayChannelAdapter({ relay }));
    const result = await new Promise((callback) => { events.emit("channel:send", { adapter: "relay", recipient: "chat_1", text: "hello", callback }); });
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("chat_1", { message: { parts: [{ type: "text", value: "hello" }], idempotency_key: expect.stringMatching(/^pi-channels-.+-0$/u) } });
    await new Promise((callback) => { events.emit("channel:send", { adapter: "me", recipient: "", text: "via route", callback }); });
    expect(send).toHaveBeenLastCalledWith("chat_9", expect.anything());
  });
  it("sends fenced blocks as their parts, through the SDK's answer parser", async () => {
    const { relay, send } = fakeRelay();
    await relayChannelAdapter({ relay }).send({ adapter: "relay", recipient: "chat_1", text: "Which?\n\n```buttons\n[{\"label\": \"A\"}]\n```", metadata: { idempotencyKey: "k" } });
    expect(send).toHaveBeenCalledWith("chat_1", { message: { parts: [{ type: "text", value: "Which?" }, { type: "buttons", items: [{ label: "A" }] }], idempotency_key: "k-0" } });
  });
  it("refuses a message with no chat, and shows typing in the chat", async () => {
    const { relay, startTyping } = fakeRelay();
    const adapter = relayChannelAdapter({ relay });
    await expect(adapter.send({ adapter: "relay", recipient: "", text: "x" })).rejects.toThrow("chat id");
    await adapter.sendTyping("chat_1");
    expect(startTyping).toHaveBeenCalledWith("chat_1");
  });
});

describe("receiving", () => {
  it("emits an inbound Relay Message on channel:receive and hands it to the chat bridge, whose reply goes back to the chat", async () => {
    const events = createEventBus();
    const host = piChannelsHost(events);
    const fake = fakeRelay();
    registerRelayAdapter(events, () => relayChannelAdapter({ relay: fake.relay }));
    await fake.deliver(event("e1", [text("hi there")]));
    const expected = { adapter: "relay", sender: "chat_1", text: "hi there\n\n[Relay message id: message-e1]", metadata: expect.objectContaining({ eventId: "e1", messageId: "message-e1", chatId: "chat_1", handle: "alice" }) };
    expect(host.received).toEqual([expected]);
    expect(host.bridged).toEqual([expected]);
    expect(await host.bridge.sendReply(host.bridged[0]!.adapter, host.bridged[0]!.sender, "hello back")).toEqual({ ok: true });
    expect(fake.send).toHaveBeenCalledWith("chat_1", expect.objectContaining({ message: expect.objectContaining({ parts: [{ type: "text", value: "hello back" }] }) }));
  });
  it("skips its own Messages, other senders when listed, and a redelivered event", async () => {
    const events = createEventBus();
    const host = piChannelsHost(events);
    const fake = fakeRelay();
    registerRelayAdapter(events, () => relayChannelAdapter({ relay: fake.relay, senders: ["@Alice"] }));
    await fake.deliver(event("e1", [text("mine")], { direction: "outbound" }));
    await fake.deliver(event("e2", [text("stranger")], { handle: "mallory" }));
    await fake.deliver(event("e3", [text("ok")]));
    await fake.deliver(event("e3", [text("ok")]));
    expect(host.received.map((message) => message.text)).toEqual(["ok\n\n[Relay message id: message-e3]"]);
  });
  it("names the Message's id, so a bridged answer can thread to it with a reply tag", async () => {
    const events = createEventBus();
    const host = piChannelsHost(events);
    const fake = fakeRelay();
    registerRelayAdapter(events, () => relayChannelAdapter({ relay: fake.relay }));
    await fake.deliver(event("e7", [text("which one?")]));
    expect(host.bridged[0]!.text).toBe("which one?\n\n[Relay message id: message-e7]");
    await host.bridge.sendReply("relay", "chat_1", "[[reply_to:message-e7]] This one.");
    expect(fake.send).toHaveBeenCalledWith("chat_1", { message: { parts: [{ type: "text", value: "This one." }], idempotency_key: expect.stringMatching(/-0$/u), reply_to: { message_id: "message-e7" } } });
    // No Message is current on the pi-channels path, so reply_to_current is removed and threads nothing.
    fake.send.mockClear();
    await host.bridge.sendReply("relay", "chat_1", "[[reply_to_current]] Plain.");
    expect(fake.send).toHaveBeenCalledWith("chat_1", { message: { parts: [{ type: "text", value: "Plain." }], idempotency_key: expect.stringMatching(/-0$/u) } });
  });
  it("gives a photo as a downloaded image attachment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("png"))));
    const events = createEventBus();
    const host = piChannelsHost(events);
    const fake = fakeRelay();
    const dir = await mkdtemp(join(tmpdir(), "relay-pi-channels-"));
    registerRelayAdapter(events, () => relayChannelAdapter({ relay: fake.relay, downloadDir: dir }));
    await fake.deliver(event("e1", [media("img", "image/png", "a.png")]));
    const [attachment] = host.bridged[0]!.attachments!;
    expect(attachment).toMatchObject({ type: "image", filename: "a.png", mimeType: "image/png", size: 3 });
    expect(attachment!.path.startsWith(dir)).toBe(true);
    expect(await readFile(attachment!.path, "utf8")).toBe("png");
  });
});

describe("the Pi extension", () => {
  it("registers the adapter on resources_discover when pi-channels settings have a relay key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-pi-agent-"));
    const cwd = await mkdtemp(join(tmpdir(), "relay-pi-cwd-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ "pi-channels": { relay: { agentTokenCommand: ["echo", "token"] } } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("RELAY_AGENT_TOKEN", "");
    const events = createEventBus();
    const host = piChannelsHost(events, { autoStart: false });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    relayPiExtension({ events, on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(name, handler); }, registerCommand: vi.fn(), registerTool: vi.fn() } as never);
    await handlers.get("resources_discover")!({ type: "resources_discover", cwd, reason: "startup" }, {});
    expect(host.adapters.has(RELAY_ADAPTER)).toBe(true);
  });
  it("reads pi-channels.relay from global settings, with the project's over it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-pi-agent-"));
    const cwd = await mkdtemp(join(tmpdir(), "relay-pi-cwd-"));
    expect(await piChannelsRelaySettings(cwd, dir)).toBeUndefined();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ "pi-channels": { relay: { senders: ["a"], baseURL: "https://g.test" } } }));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-channels": { relay: { senders: ["b"] } } }));
    expect(await piChannelsRelaySettings(cwd, dir)).toEqual({ senders: ["b"], baseURL: "https://g.test" });
  });
});
