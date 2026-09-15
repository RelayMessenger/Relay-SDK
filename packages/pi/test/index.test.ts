import { describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { PiChannel, type PiProcess } from "../src/index.js";
import native from "../src/native.js";

const makeEvent = (id: string, chat: string): RelayWebhookEvent => ({
  event_type: "message.received", event_id: id, api_version: "v1", webhook_version: "2026-08-30", trace_id: "trace", agent_id: "agent",
  created_at: "2026-01-01T00:00:00Z", data: { direction: "inbound", id: `message-${id}`, chat: { id: chat } as never, sender_handle: { handle: "alice" } as never, parts: [{ type: "text", value: "hello", reactions: null }] },
});
const records = (answer: string, settledFirst = false): string[] => settledFirst
  ? [JSON.stringify({ type: "agent_settled" }), JSON.stringify({ id: "1", type: "response", success: true }), JSON.stringify({ id: "2", type: "response", success: true, data: { text: answer } })]
  : [JSON.stringify({ id: "1", type: "response", success: true }), JSON.stringify({ type: "agent_settled" }), JSON.stringify({ id: "2", type: "response", success: true, data: { text: answer } })];
function fakePi(output: string[]): PiProcess { async function* lines(): AsyncGenerator<string> { yield* output; } return { stdin: { write: vi.fn(), end: vi.fn() }, stdout: lines(), kill: vi.fn() }; }
function blockedPi(): PiProcess {
  async function* lines(): AsyncGenerator<string> {
    await new Promise<void>(() => {});
  }
  return { stdin: { write: vi.fn(), end: vi.fn() }, stdout: lines(), kill: vi.fn() };
}
function relayFor(events: RelayWebhookEvent[], send = vi.fn().mockResolvedValue({})): { relay: Relay; send: typeof send } { return { relay: { chats: { messages: { send } }, websocket: { run: async (options: { onEvent: (event: RelayWebhookEvent) => Promise<void> }) => { await Promise.all(events.map(options.onEvent)); } } } as unknown as Relay, send }; }

describe("Pi channel", () => {
  it("isolates live sessions per chat and handles settled before prompt response", async () => {
    const { relay, send } = relayFor([makeEvent("a", "one"), makeEvent("b", "two")]); const spawned: string[] = [];
    await new PiChannel({ agentToken: "secret", relay, spawnPi: (_command, _args, chat) => { spawned.push(chat); return fakePi(records(chat, true)); } }).run();
    expect(spawned).toEqual(["one", "two"]); expect(send).toHaveBeenCalledTimes(2);
  });
  it("deduplicates concurrent replay and chunks replies", async () => {
    const event = makeEvent("same", "one"); const send = vi.fn().mockResolvedValue({}); const { relay } = relayFor([event, event], send);
    await new PiChannel({ agentToken: "secret", relay, spawnPi: () => fakePi(records("x".repeat(10_001))) }).run();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("times out and stops on abort", async () => {
    const process = blockedPi(); const { relay } = relayFor([makeEvent("timeout", "one")]); const channel = new PiChannel({ agentToken: "secret", relay, rpcTimeoutMs: 5, spawnPi: () => process });
    await expect(channel.run()).rejects.toThrow(/timed out/); expect(process.kill).toHaveBeenCalled();
  });
  it("aborts a live RPC turn and kills its process", async () => {
    const process = blockedPi(); const { relay } = relayFor([makeEvent("abort", "one")]); const controller = new AbortController();
    const channel = new PiChannel({ agentToken: "secret", relay, rpcTimeoutMs: 1000, spawnPi: () => process });
    const run = channel.run(controller.signal); setTimeout(() => controller.abort(), 1);
    await expect(run).rejects.toThrow(/aborted/); expect(process.kill).toHaveBeenCalled();
  });
});

describe("native extension", () => { it("loads and registers only the documented commands", () => { const names: string[] = []; native({ registerCommand: (name: string) => names.push(name) } as never); expect(names).toEqual(["relay-connect", "relay-disconnect"]); }); });
