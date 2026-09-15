import { describe, expect, it, vi } from "vitest";
import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { PiChannel, type PiProcess } from "../src/index.js";

const event = {
  event_type: "message.received",
  event_id: "evt",
  data: {
    direction: "inbound",
    id: "msg",
    chat: { id: "chat" },
    sender_handle: { handle: "alice" },
    parts: [{ type: "text", value: "hello" }],
  },
} as unknown as RelayWebhookEvent;
function fakePi(lines: string[]): PiProcess {
  async function* output(): AsyncGenerator<string> {
    yield* lines;
  }
  return { stdin: { write: vi.fn(), end: vi.fn() }, stdout: output(), kill: vi.fn() };
}

describe("Pi channel", () => {
  it("prompts Pi and sends one final answer", async () => {
    const create = vi.fn().mockResolvedValue({});
    const relay = {
      chats: { messages: { send: create } },
      websocket: { run: async (options: { onEvent: (value: RelayWebhookEvent) => Promise<void> }) => options.onEvent(event) },
    } as unknown as Relay;
    const pi = fakePi([
      JSON.stringify({ id: "1", type: "response", command: "prompt", success: true }),
      JSON.stringify({ type: "agent_settled" }),
      JSON.stringify({ id: "2", type: "response", command: "get_last_assistant_text", success: true, data: { text: "hi" } }),
    ]);
    await new PiChannel({ agentToken: "secret", relay, spawnPi: () => pi }).run();
    expect(create).toHaveBeenCalledWith("chat", expect.objectContaining({ message: expect.objectContaining({ parts: [{ type: "text", value: "hi" }] }) }));
  });
});
