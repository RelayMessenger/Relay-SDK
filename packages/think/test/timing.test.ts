import { describe, expect, it } from "vitest";

import {
  relayChatTimingLine,
  startRelayChatTiming,
  timedRelayModel,
} from "../src/timing";

function usage(cacheRead: number | undefined, reasoning?: number) {
  return {
    inputTokens: { total: 1200, noCache: 1200 - (cacheRead ?? 0), cacheRead, cacheWrite: undefined },
    outputTokens: { total: 40, text: 40 - (reasoning ?? 0), reasoning },
    raw: undefined,
  };
}

async function runFinish(
  cacheRead: number | undefined,
  { reasoning, headers }: { reasoning?: number; headers?: Record<string, string> } = {},
) {
  const timing = startRelayChatTiming({ instance: "i", eventId: "e" });
  const middleware = timedRelayModel(() => timing);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: usage(cacheRead, reasoning) });
      controller.close();
    },
  });
  const wrapped = await middleware.wrapStream!({
    doStream: async () => ({ stream, response: { headers } }) as never,
    doGenerate: async () => ({}) as never,
    params: {} as never,
    model: { modelId: "gemini-test" } as never,
  });
  for await (const _ of wrapped.stream) { /* drain */ }
  return JSON.parse(relayChatTimingLine(timing)) as {
    tokens: { input: number; output: number; reasoning: number | null; cached: number };
    gateway: Record<string, string> | null;
    ms: { model_headers: number | null };
  };
}

describe("relay_chat_timing tokens", () => {
  it("carries the provider's cached input token count", async () => {
    const line = await runFinish(900);
    expect(line.tokens).toEqual({ input: 1200, output: 40, reasoning: null, cached: 900 });
  });

  it("reports 0 cached when the provider gives none", async () => {
    const line = await runFinish(undefined);
    expect(line.tokens).toEqual({ input: 1200, output: 40, reasoning: null, cached: 0 });
  });

  it("carries the thinking tokens and the AI Gateway's own headers, so a slow first chunk can be read", async () => {
    const line = await runFinish(0, {
      reasoning: 30,
      headers: { "cf-aig-log-id": "log-1", "cf-aig-step": "0", "content-type": "text/event-stream" },
    });
    expect(line.tokens.reasoning).toBe(30);
    expect(line.gateway).toEqual({ "cf-aig-log-id": "log-1", "cf-aig-step": "0" });
    expect(line.ms.model_headers).not.toBeNull();
  });
});
