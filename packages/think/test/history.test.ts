import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { capHistoryTokens, historyTokens, MAX_HISTORY_TOKENS, withoutPastThoughtSignatures } from "../src/history";

afterEach(() => {
  vi.restoreAllMocks();
});

/** One Message of exactly `tokens` estimated tokens (4 characters each). */
function turn(role: "user" | "assistant", tokens: number, tag: string): ModelMessage {
  return { role, content: tag + "x".repeat(tokens * 4 - tag.length) };
}

describe("chat history cap", () => {
  it("counts text at four characters per token and ignores file bytes", () => {
    expect(historyTokens({ role: "user", content: "x".repeat(400) })).toBe(100);
    expect(historyTokens({
      role: "user",
      content: [
        { type: "text", text: "x".repeat(40) },
        { type: "file", data: "A".repeat(100_000), mediaType: "image/png" },
      ],
    })).toBe(10);
  });

  it("keeps every Message when the history is inside the budget", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const messages = [
      turn("user", 10, "a"),
      turn("assistant", 10, "b"),
      turn("user", 10, "c"),
    ];
    expect(capHistoryTokens(messages)).toEqual(messages);
    expect(log).not.toHaveBeenCalled();
  });

  it("drops the oldest Messages whole, keeps the newest, and logs one line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const messages = [
      turn("user", 60, "oldest"),
      turn("assistant", 60, "older"),
      turn("user", 60, "newer"),
      turn("assistant", 60, "newest"),
    ];

    const capped = capHistoryTokens(messages, 150);

    expect(capped).toEqual([messages[2], messages[3]]);
    expect(capped.map((message) => String(message.content).replace(/x+$/u, "")))
      .toEqual(["newer", "newest"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      event: "relay_history_capped",
      max_tokens: 150,
      dropped: 2,
      kept: 2,
      kept_tokens: 120,
    });
  });

  it("keeps the newest Message even when it alone exceeds the budget", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const messages = [turn("user", 50, "old"), turn("user", 500, "huge")];
    expect(capHistoryTokens(messages, 100)).toEqual([messages[1]]);
  });

  it("drops a tool result left without the assistant call it answers", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const messages: ModelMessage[] = [
      turn("user", 60, "oldest"),
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "send",
          input: { text: "x".repeat(200) },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "send",
          output: { type: "json", value: { status: "sent" } },
        }],
      },
      turn("user", 20, "newest"),
    ];

    const capped = capHistoryTokens(messages, 60);

    expect(capped.map((message) => message.role)).toEqual(["user"]);
    expect(capped).toEqual([messages[3]]);
  });

  it("caps at one hundred thousand tokens by default", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(MAX_HISTORY_TOKENS).toBe(100_000);
    const messages = Array.from(
      { length: 30 },
      (_unused, index) => turn(index % 2 === 0 ? "user" : "assistant", 10_000, `m${index}`),
    );

    const capped = capHistoryTokens(messages);

    expect(capped).toHaveLength(10);
    expect(capped[capped.length - 1]).toEqual(messages[messages.length - 1]);
    expect(capped.reduce((total, message) => total + historyTokens(message), 0))
      .toBeLessThanOrEqual(MAX_HISTORY_TOKENS);
  });
});

describe("thought signatures from earlier turns", () => {
  const signed = (signature: string) => ({ googleVertex: { thoughtSignature: signature } });
  const history: ModelMessage[] = [
    { role: "user", content: "yo unc, mon tue thu fri at 6pm" },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "a",
        toolName: "send",
        input: { kind: "text", text: "locked in." },
        providerOptions: signed("OLD"),
      }],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "send", output: { type: "json", value: { status: "sent" } } }] },
    { role: "user", content: "hey how are you today" },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "b",
        toolName: "follow_up",
        input: { do: "list" },
        providerOptions: signed("CURRENT"),
      }],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "b", toolName: "follow_up", output: { type: "json", value: { follow_ups: [] } } }] },
  ];

  it("leaves the turn being answered its own signatures and drops the earlier turns' ones, keeping every word and call", () => {
    const sent = withoutPastThoughtSignatures(history);
    expect(JSON.stringify(sent)).not.toContain("OLD");
    expect(JSON.stringify(sent)).toContain("CURRENT");
    expect(sent).toHaveLength(history.length);
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "a", toolName: "send", input: { kind: "text", text: "locked in." } }],
    });
    expect(sent.slice(2)).toEqual(history.slice(2));
  });
});
