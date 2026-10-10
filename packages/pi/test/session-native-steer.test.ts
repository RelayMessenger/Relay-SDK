import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { SessionChannel, type SessionPi } from "../src/session.js";
import native from "../src/native.js";

const wire = vi.hoisted(() => ({ receive: undefined as undefined | ((event: RelayWebhookEvent) => Promise<void>) }));
vi.mock("@relaymessenger/sdk", async (original) => ({
  ...await original<typeof import("@relaymessenger/sdk")>(),
  default: class {
    chats = { messages: { send: vi.fn() }, startTyping: vi.fn(), stopTyping: vi.fn() };
    websocket = {
      run: (options: { signal: AbortSignal; onEvent: (event: RelayWebhookEvent) => Promise<void> }) => {
        wire.receive = options.onEvent;
        return new Promise<void>((resolve) => { options.signal.addEventListener("abort", () => resolve(), { once: true }); });
      },
    };
  },
}));

const inbound = (id: string): RelayWebhookEvent => ({
  event_type: "message.received", event_id: `event-${id}`,
  data: {
    direction: "inbound", id, chat: { id: "chat", is_group: false },
    sender_handle: { handle: "alice", kind: "user" },
    parts: [{ type: "text", value: id, reactions: null }],
  },
}) as RelayWebhookEvent;

describe("native session steer admission", () => {
  it("queues through Pi synchronously, without entering the asynchronous input path", async () => {
    const queued: unknown[] = [];
    const input = vi.fn();
    const runtime = {
      isStreaming: true,
      agent: { steer: (message: unknown) => { queued.push(message); } },
      prompt: input,
    } as unknown as AgentSession;
    const pi: SessionPi = {
      sendUserMessage: (content, options) => {
        void AgentSession.prototype.sendUserMessage.call(runtime, content, options);
      },
      sendMessage: (message, options) => {
        void AgentSession.prototype.sendCustomMessage.call(runtime, message, options);
        // This is the real Pi method: admission happened before it returned,
        // rather than after an input-hook promise or a later settled event.
        expect(queued.at(-1)).toEqual(expect.objectContaining(message));
      },
    };
    const send = vi.fn().mockResolvedValue({});
    const relay = {
      chats: { messages: { send }, startTyping: vi.fn(), stopTyping: vi.fn() },
    } as unknown as Relay;
    let idle = false;
    const channel = new SessionChannel(pi, { agentToken: "test", relay, isIdle: () => idle });
    channel.started();
    await channel.receive(inbound("first"));
    await channel.receive(inbound("second"));
    expect(input).not.toHaveBeenCalled();
    expect(queued).toEqual(["first", "second"].map((id) => expect.objectContaining({
      role: "custom", customType: "relay-inbound",
      details: { event_id: `event-${id}`, message_id: id, chat_id: "chat" },
    })));
    channel.ended([...queued, { role: "assistant", content: [{ type: "text", text: "done" }] }]);
    idle = true;
    await channel.settled();
    expect(send).toHaveBeenCalledTimes(1);
    await channel.receive(inbound("third"));
    expect(input).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(2);
  });
  it("waits for actual idle after compaction and wires agent_start to busy steering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-session-native-"));
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    const sendUserMessage = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      on: (name: string, handler: (event: unknown, context: unknown) => unknown) => { hooks.set(name, handler); },
      registerCommand: vi.fn(), registerTool: vi.fn(), sendUserMessage, sendMessage,
    } as unknown as ExtensionAPI;
    let idle = false;
    try {
      await writeFile(join(directory, "settings.json"), JSON.stringify({ relay: { mode: "session" } }));
      vi.stubEnv("PI_CODING_AGENT_DIR", directory);
      vi.stubEnv("RELAY_PI_MODE", "session");
      vi.stubEnv("RELAY_AGENT_TOKEN", "test");
      vi.stubEnv("RELAY_PI_CHAT_ID", "");
      vi.stubEnv("RELAY_BASE_URL", "https://relay.invalid");
      vi.stubEnv("PI_SUBAGENT_CHILD", "");
      native(pi);
      await hooks.get("session_start")!({}, { mode: "rpc", isIdle: () => idle });
      vi.useFakeTimers();
      await wire.receive!(inbound("during-compaction"));
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(75);
      expect(sendUserMessage).not.toHaveBeenCalled();
      idle = true;
      await vi.advanceTimersByTimeAsync(25);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      idle = false;
      await hooks.get("agent_start")?.({}, {});
      await wire.receive!(inbound("during-run"));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        details: { event_id: "event-during-run", message_id: "during-run", chat_id: "chat" },
      }), { deliverAs: "steer" });
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
    } finally {
      await hooks.get("session_shutdown")?.({}, {});
      wire.receive = undefined;
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("queues arrivals while Pi is idle but Relay's settled handler is still waiting", async () => {
    const input = vi.fn();
    const appended = vi.fn();
    const runtime = { isStreaming: false, prompt: input, _appendCustomMessage: appended } as unknown as AgentSession;
    const pi: SessionPi = {
      sendUserMessage: (content, options) => { void AgentSession.prototype.sendUserMessage.call(runtime, content, options); },
      sendMessage: (message, options) => { void AgentSession.prototype.sendCustomMessage.call(runtime, message, options); },
    };
    const send = vi.fn().mockResolvedValue({});
    const relay = { chats: { messages: { send }, startTyping: vi.fn(), stopTyping: vi.fn() } } as unknown as Relay;
    const channel = new SessionChannel(pi, { agentToken: "test", relay, isIdle: () => true });
    await channel.receive(inbound("first"));
    channel.started();
    channel.ended([{ role: "assistant", content: [{ type: "text", text: "first answer" }] }]);
    // Pi has cleared its active state, but an earlier settled handler has
    // not returned yet. Relay still remembers the previous agent_start.
    await channel.receive(inbound("second"));
    expect(appended).not.toHaveBeenCalled();
    expect(input).toHaveBeenCalledTimes(1);
    await channel.settled();
    expect(input).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    channel.stop();
  });
});
