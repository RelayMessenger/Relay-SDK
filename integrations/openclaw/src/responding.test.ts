import { describe, expect, it } from "vitest";
import type { RelayClient } from "./client.js";
import { markRespondingBeforeAttempt } from "./responding.js";

function clientWithResponding(
  setResponding: RelayClient["setResponding"],
): RelayClient {
  return {
    getMe: async () => {
      throw new Error("not used");
    },
    pollEvents: async () => {
      throw new Error("not used");
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
    setTyping: async () => {},
    setResponding,
    markRead: async () => {},
  };
}

describe("markRespondingBeforeAttempt", () => {
  it("marks the exact watermark before the durable attempt and engine", async () => {
    const order: string[] = [];
    const client = clientWithResponding(async (params) => {
      order.push(`responding:${params.messageId}:${params.label}`);
    });

    await markRespondingBeforeAttempt({
      client,
      conversationId: "cnv_1",
      messageId: "msg_9",
      label: "OpenClaw",
      markAttempt: async () => {
        order.push("attempt");
      },
    });
    order.push("engine");

    expect(order).toEqual([
      "responding:msg_9:OpenClaw",
      "attempt",
      "engine",
    ]);
  });

  it("propagates responding failure before the attempt or engine", async () => {
    const order: string[] = [];
    const client = clientWithResponding(async () => {
      order.push("responding");
      throw new Error("receipt rejected");
    });

    await expect(
      (async () => {
        await markRespondingBeforeAttempt({
          client,
          conversationId: "cnv_1",
          messageId: "msg_9",
          label: "OpenClaw",
          markAttempt: async () => {
            order.push("attempt");
          },
        });
        order.push("engine");
      })(),
    ).rejects.toThrow("receipt rejected");

    expect(order).toEqual(["responding"]);
  });
});
