import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startRelayTypingLifecycle,
  TYPING_REFRESH_MS,
} from "../src/typing";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Relay whole-turn typing lifecycle", () => {
  it("starts immediately, refreshes every 60 seconds, and stops once", async () => {
    vi.useFakeTimers();
    const startTyping = vi.fn(async () => undefined);
    const stopTyping = vi.fn(async () => undefined);
    const lifecycle = await startRelayTypingLifecycle({
      chats: { startTyping, stopTyping },
    }, "chat-1");

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(stopTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    expect(startTyping).toHaveBeenCalledTimes(2);

    await lifecycle.stop();
    await lifecycle.stop();
    expect(stopTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
    expect(startTyping).toHaveBeenCalledTimes(2);
  });

  it("still returns a stoppable lifecycle when Relay rejects start", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const startTyping = vi.fn(async () => {
      throw new Error("synthetic start failure");
    });
    const stopTyping = vi.fn(async () => undefined);
    const lifecycle = await startRelayTypingLifecycle({
      chats: { startTyping, stopTyping },
    }, "chat-2");

    await lifecycle.stop();
    expect(stopTyping).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join("\n"))
      .toContain('"operation":"start"');
  });

  it("swallows a failed stop once and never resurrects refresh", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const startTyping = vi.fn(async () => undefined);
    const stopTyping = vi.fn(async () => {
      throw new Error("synthetic stop failure");
    });
    const lifecycle = await startRelayTypingLifecycle({
      chats: { startTyping, stopTyping },
    }, "chat-3");

    await lifecycle.stop();
    await lifecycle.stop();
    expect(stopTyping).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join("\n"))
      .toContain('"operation":"stop"');

    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
    expect(startTyping).toHaveBeenCalledTimes(1);
  });
});
