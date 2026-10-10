// The AI SDK runs the tool calls of one step in parallel. A send's place in
// the turn is assigned when its call reaches Think's key function, so the
// calls must reach it in the step's order. This drives ai's own streamText
// with two parallel calls and the same await chain Think puts before the key.
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({ action: (config: unknown) => ({ config }) }));
import { relayCallNumber } from "../src/actions";

describe("parallel send calls in one step", () => {
  it("reach the key function in the order the model made them", async () => {
    const order: Array<[string, number]> = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "first", toolName: "send", input: "{}" },
          { type: "tool-call", toolCallId: "second", toolName: "send", input: "{}" },
          { type: "tool-call", toolCallId: "third", toolName: "send", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          } },
        ]),
      }),
    });
    const result = streamText({
      model,
      prompt: "hi",
      stopWhen: stepCountIs(1),
      tools: {
        send: tool({
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (_input, { toolCallId }) => {
            // Think's wrapper awaits authorization before it resolves the key.
            await Promise.resolve();
            await Promise.resolve();
            order.push([toolCallId, relayCallNumber("send", { chatId: "c", eventId: "order" }, { requestId: "r", toolCallId })]);
            return "sent";
          },
        }),
      },
    });
    await result.consumeStream();
    expect(order).toEqual([["first", 1], ["second", 2], ["third", 3]]);
  });
});
