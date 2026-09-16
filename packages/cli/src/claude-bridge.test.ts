import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, runClaudeBridge } from "./claude-bridge.js";
import { codexPrompt } from "./codex-bridge.js";
import type { ClaudeThreadStore } from "./claude-threads.js";

const received = (eventId: string, chatId: string, text: string, sender = "alice"): RelayWebhookEvent => ({
  api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
  event_id: eventId, created_at: "2026-09-11T00:00:00.000Z", trace_id: "trace", agent_id: "agent",
  data: {
    chat: { id: chatId }, id: "message", direction: "inbound",
    sender_handle: { id: "sender", handle: sender, kind: "user" },
    parts: [{ type: "text", value: text, reactions: null }],
  },
} as unknown as RelayWebhookEvent);

/** Relay, reduced to what the bridge touches, with every call written down. */
function fakeRelay(events: readonly RelayWebhookEvent[]) {
  const typing: string[] = [];
  const sent: Array<{ chatId: string; text: string; key: string | undefined }> = [];
  let sendFails = false;
  const client = {
    chats: {
      startTyping: async (chatID: string) => { typing.push(`start ${chatID}`); },
      stopTyping: async (chatID: string) => { typing.push(`stop ${chatID}`); },
      messages: {
        send: async (chatID: string, body: { message: { parts: Array<{ value?: string }>; idempotency_key?: string } }) => {
          if (sendFails) throw new Error("Relay refused this send.");
          sent.push({ chatId: chatID, text: body.message.parts[0]?.value ?? "", key: body.message.idempotency_key });
          return {} as never;
        },
      },
    },
    websocket: {
      // Relay's own connection hands one event over at a time and waits for
      // each to be taken before the next (packages/sdk/src/websocket.ts).
      run: async (options: { onEvent(event: RelayWebhookEvent, context: { sequence: string }): Promise<void> }) => {
        for (const [index, event] of events.entries()) await options.onEvent(event, { sequence: String(index + 1) });
      },
    },
  } as unknown as Pick<Relay, "chats" | "websocket">;
  return { client, typing, sent, failSends: () => { sendFails = true; } };
}

/** Every way one message can end on the terminal. */
const ENDED = /Sent the answer|gave no answer|did not reach Relay|was dropped/u;

/**
 * The bridge hands a message to Codex and lets the turn finish behind it, so a
 * test waits for the messages to end rather than for the connection to close.
 */
const untilEnded = async (said: readonly string[], count: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (said.filter((line) => ENDED.test(line)).length >= count) return;
    if (Date.now() > deadline) throw new Error(`Only these messages ended: ${said.join(" | ")}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

/** The thread ids, kept in memory, for the tests that are not about the file. */
const memoryThreads = (): ClaudeThreadStore => {
  const threads = new Map<string, string>();
  return {
    get: (chatId) => threads.get(chatId),
    set: async (chatId, threadId) => { threads.set(chatId, threadId); },
  };
};


const mcpServer = { command: "npx", args: ["-y", "@relaymessenger/mcp", "--profile", "test"], env: { RELAY_CONFIG_PATH: "profile.json" } };
const init = (id: string): SDKMessage => ({ type: "system", subtype: "init", session_id: id } as SDKMessage);
const success = (text = "Answer"): SDKMessage => ({ type: "result", subtype: "success", is_error: false, result: text, session_id: "session-1" } as SDKMessage);
const fakeQuery = (generate: (input: Parameters<typeof query>[0]) => AsyncGenerator<SDKMessage>): typeof query =>
  generate as typeof query;

const setup = (ask: typeof query, events: RelayWebhookEvent[]) => {
  const relay = fakeRelay(events);
  const threads = memoryThreads();
  const control = new AbortController();
  const said: string[] = [];
  const input = { client: relay.client, threads, query: ask, signal: control.signal, say: (line: string) => said.push(line),
    claude: { executable: "/bin/claude" }, cwd: "/project", mcpServer };
  return { relay, threads, control, said, input };
};

describe("Claude Agent SDK bridge", () => {
  it("passes the prompt, execution options and Relay MCP server, saves and resumes the chat session", async () => {
    const calls: Parameters<typeof query>[0][] = [];
    const ask = fakeQuery(async function* (input) {
      calls.push(input);
      yield init("session-1");
      yield success("  Answer  ");
    });
    const state = setup(ask, [received("event-1", "chat-1", "hello")]);
    await runClaudeBridge(state.input);
    await untilEnded(state.said, 1);
    expect(calls[0]).toEqual({ prompt: codexPrompt("alice", "hello"), options: {
      cwd: "/project", resume: undefined, pathToClaudeCodeExecutable: "/bin/claude",
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      mcpServers: { relay: mcpServer }, abortController: expect.any(AbortController),
    } });
    expect(state.threads.get("chat-1")).toBe("session-1");
    expect(state.relay.sent).toEqual([{ chatId: "chat-1", text: "Answer", key: "codex-bridge-event-1" }]);
    expect(state.relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(state.said).toEqual(["@alice  hello", "Sent the answer to @alice."]);
    const second = fakeRelay([received("event-2", "chat-1", "again")]);
    await runClaudeBridge({ ...state.input, client: second.client });
    await untilEnded(state.said, 2);
    expect(calls[1]?.options?.resume).toBe("session-1");
    expect(calls[1]?.prompt).toBe(codexPrompt("alice", "again"));
    state.control.abort();
  });

  it("aborts an older turn before starting the replacement and never sends its reply", async () => {
    const order: string[] = [];
    let calls = 0;
    const ask = fakeQuery(async function* ({ options }) {
      const call = ++calls;
      order.push(`start ${call}`);
      yield init("session-1");
      if (call === 1) {
        await new Promise<void>((resolve) => {
          const aborted = () => { order.push("abort 1"); resolve(); };
          if (options!.abortController!.signal.aborted) aborted();
          else options!.abortController!.signal.addEventListener("abort", aborted, { once: true });
        });
      }
      yield success(`answer ${call}`);
      order.push(`end ${call}`);
    });
    const state = setup(ask, [received("event-1", "chat-1", "old"), received("event-2", "chat-1", "new")]);
    await runClaudeBridge(state.input);
    await untilEnded(state.said, 2);
    expect(order.indexOf("abort 1")).toBeLessThan(order.indexOf("start 2"));
    expect(state.relay.sent.map((item) => item.text)).toEqual(["answer 2"]);
    expect(state.said).toContain("A newer message came in, so the answer to @alice was dropped.");
    state.control.abort();
  });

  it("runs different chats in parallel with separate session ids", async () => {
    let calls = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const ask = fakeQuery(async function* () {
      const call = ++calls;
      yield init(`session-${call}`);
      if (call === 2) release();
      await bothStarted;
      yield success();
    });
    const state = setup(ask, [received("event-1", "chat-1", "first"), received("event-2", "chat-2", "second")]);
    await runClaudeBridge(state.input);
    await untilEnded(state.said, 2);
    expect(state.threads.get("chat-1")).toBe("session-1");
    expect(state.threads.get("chat-2")).toBe("session-2");
    expect(state.relay.sent).toHaveLength(2);
    state.control.abort();
  });

  it.each([
    { type: "result", subtype: "error_during_execution", errors: ["failed"] },
    { type: "result", subtype: "success", is_error: true, result: "API error" },
  ])("reports a failed SDK turn without replying: $subtype", async (error) => {
    const state = setup(fakeQuery(async function* () { yield init("session-1"); yield error as SDKMessage; }),
      [received("event-1", "chat-1", "hello")]);
    await runClaudeBridge(state.input);
    await untilEnded(state.said, 1);
    expect(state.relay.sent).toEqual([]);
    expect(state.said.at(-1)).toBe("Claude Code gave no answer to @alice, so nothing was sent.");
    state.control.abort();
  });

  it("filters non-inbound events and repeated deliveries", async () => {
    let calls = 0;
    const event = received("event-1", "chat-1", "hello");
    const state = setup(fakeQuery(async function* () { calls++; yield init("session-1"); yield success(); }),
      [{ ...event, event_type: "message.sent" } as RelayWebhookEvent, event, event]);
    await runClaudeBridge(state.input);
    await untilEnded(state.said, 1);
    expect(calls).toBe(1);
    expect(state.relay.sent).toHaveLength(1);
    state.control.abort();
  });
});


describe("the Claude executable the bridge starts", () => {
  it("resolves the Windows npm shim", async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-claude-path-"));
    try {
      await writeFile(join(folder, "claude.cmd"), "@echo off\r\n");
      expect(await claudeCommand("claude", { PATH: folder }, "win32")).toEqual({ executable: join(folder, "claude.cmd") });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it("leaves a Windows shell name when PATH has no shim", async () => {
    expect(await claudeCommand("claude", { PATH: "" }, "win32")).toEqual({ executable: "claude.cmd" });
  });
  it("keeps the absolute executable connect found", async () => {
    const executable = join(tmpdir(), "bin", "claude");
    expect(await claudeCommand(executable, { PATH: "" }, "darwin")).toEqual({ executable });
  });
});
