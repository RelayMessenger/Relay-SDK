import { threadIdContract } from "@chat-adapter/tests";
import { describe, expect, it } from "vitest";
import {
  createRelayAdapter,
  decodeRelayThreadId,
  encodeRelayThreadId,
} from "../src/index.js";
import { IDS } from "./helpers.js";

const adapter = createRelayAdapter();

threadIdContract({
  cases: [
    {
      decoded: { chatId: IDS.chat },
      encoded: `relay:${IDS.chat}`,
    },
    { decoded: { chatId: IDS.otherChat } },
  ],
  decode: (id) => adapter.decodeThreadId(id),
  encode: (data) => adapter.encodeThreadId(data),
  name: "relay",
});

describe("Relay thread IDs", () => {
  it("uses the same stable ID for the channel and thread", () => {
    const threadId = encodeRelayThreadId({ chatId: IDS.chat });
    expect(adapter.channelIdFromThreadId(threadId)).toBe(threadId);
    expect(decodeRelayThreadId(threadId)).toEqual({
      chatId: IDS.chat,
    });
  });

  it.each([
    "relay:",
    "relay:not-a-uuid",
    `slack:${IDS.chat}`,
    `relay:${IDS.chat}:extra`,
  ])("rejects malformed ID %s", (id) => {
    expect(() => adapter.decodeThreadId(id)).toThrow(
      /Relay|relay/,
    );
  });
});
