import { describe, expect, it, vi } from "vitest";
import { PiChannel, type PiProcess } from "../src/index.ts";

const event = { event_type: "message.received", event_id: "evt", data: { direction: "inbound", id: "msg", chat: { id: "chat" }, sender_handle: { handle: "alice" }, parts: [{ type: "text", value: "hello" }] } } as any;
function fakePi(lines: string[]): PiProcess { return { stdin: { write: vi.fn(), end: vi.fn() }, stdout: lines, kill: vi.fn() } as any; }

describe("Pi channel", () => {
  it("prompts Pi and sends one final answer", async () => {
    const create = vi.fn().mockResolvedValue({});
    const relay = { chats: { messages: { send: create } }, websocket: { run: async ({ onEvent }: any) => onEvent(event) } } as any;
    const pi = fakePi([
      JSON.stringify({ id: "1", type: "response", command: "prompt", success: true }),
      JSON.stringify({ type: "agent_settled" }),
      JSON.stringify({ id: "2", type: "response", command: "get_last_assistant_text", success: true, data: { text: "hi" } }),
    ]);
    await new PiChannel({ agentToken: "secret", relay, spawnPi: () => pi }).run();
    expect(create).toHaveBeenCalledWith("chat", expect.objectContaining({ message: expect.objectContaining({ parts: [{ type: "text", value: "hi" }] }) }));
  });
});
