import { describe, expect, it } from "vitest";
import { RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import { markRespondingBeforeAttempt } from "./responding.js";

function clientWithResponding(
  setResponding: RelayClient["setResponding"],
): RelayClient {
  return {
    baseUrl: "https://api.relayapp.im",
    getMe: async () => {
      throw new Error("not used");
    },
    pollEvents: async () => {
      throw new Error("not used");
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
    sendText: async () => {
      throw new Error("not used");
    },
    setTyping: async () => {},
    setResponding,
    markDelivered: async () => {},
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
      facts: { conversationId: "cnv_1", messageId: "msg_9" },
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

  it("sends the invocation id a group receipt requires", async () => {
    const seen: Array<string | undefined> = [];
    const client = clientWithResponding(async (params) => {
      seen.push(params.invocationId);
    });

    await markRespondingBeforeAttempt({
      client,
      facts: { conversationId: "cnv_group", messageId: "msg_9", invocationId: "inv_123" },
      label: "OpenClaw",
      markAttempt: async () => {},
    });

    expect(seen).toEqual(["inv_123"]);
  });

  it("omits the invocation id entirely for a direct message", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = clientWithResponding(async (params) => {
      seen.push(params as unknown as Record<string, unknown>);
    });

    await markRespondingBeforeAttempt({
      client,
      facts: { conversationId: "cnv_dm", messageId: "msg_9" },
      label: "OpenClaw",
      markAttempt: async () => {},
    });

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!)).not.toContain("invocationId");
  });

  // The defect this reverses: a refused receipt used to throw here, before the
  // attempt marker, which sent the poll loop down its replay branch and froze
  // the channel's one delivery cursor forever (REL-167).
  it("answers anyway when the server refuses the receipt, and still marks the attempt", async () => {
    const order: string[] = [];
    const failures: string[] = [];
    const client = clientWithResponding(async () => {
      order.push("responding");
      throw new RelayApiError(
        "relay: POST /v1/conversations/cnv_1/responding failed with 403: group typing requires invocation_id",
        { status: 403, kind: "rejected" },
      );
    });

    await markRespondingBeforeAttempt({
      client,
      facts: { conversationId: "cnv_1", messageId: "msg_9" },
      label: "OpenClaw",
      markAttempt: async () => {
        order.push("attempt");
      },
      onReceiptFailure: (line) => failures.push(line),
    });
    order.push("engine");

    expect(order).toEqual(["responding", "attempt", "engine"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("msg_9");
    expect(failures[0]).toContain("group typing requires invocation_id");
  });

  it("still settles on abort rather than answering a cancelled turn", async () => {
    const order: string[] = [];
    const client = clientWithResponding(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    await expect(
      markRespondingBeforeAttempt({
        client,
        facts: { conversationId: "cnv_1", messageId: "msg_9" },
        label: "OpenClaw",
        markAttempt: async () => {
          order.push("attempt");
        },
      }),
    ).rejects.toThrow("aborted");

    expect(order).toEqual([]);
  });
});
