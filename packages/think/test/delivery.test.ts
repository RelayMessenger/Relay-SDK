import { deliverMessengerReply } from "@cloudflare/think/messengers";
import { describe, expect, it } from "vitest";
import { RELAY_MESSENGER_DELIVERY } from "../src/delivery";

/** Runs Think's own messenger delivery on a turn whose model also wrote plain words. */
async function posted(policy: Parameters<typeof deliverMessengerReply>[0]["policy"], words: string): Promise<string[]> {
  const posts: string[] = [];
  const surface = {
    post: async (message: unknown) => {
      let text = "";
      if (typeof message === "string") text = message;
      else if (message && typeof message === "object" && Symbol.asyncIterator in message) {
        for await (const chunk of message as AsyncIterable<unknown>) text += typeof chunk === "string" ? chunk : "";
      } else text = (message as { markdown?: string }).markdown ?? "";
      // The Relay adapter sends nothing for empty text (stream() noop).
      if (text) posts.push(text);
    },
  };
  const target = {
    chat: async (_message: unknown, callback: { onStart?(e: unknown): void; onEvent(json: string): void; onDone(): void }) => {
      callback.onStart?.({ requestId: "r" });
      if (words) {
        callback.onEvent(JSON.stringify({ type: "text-start", id: "t" }));
        callback.onEvent(JSON.stringify({ type: "text-delta", id: "t", delta: words }));
        callback.onEvent(JSON.stringify({ type: "text-end", id: "t" }));
      }
      callback.onDone();
    },
    cancelChat: () => undefined,
  };
  await deliverMessengerReply({
    event: { message: { text: "hi" } } as never,
    surface: surface as never,
    target: target as never,
    userMessage: { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] } as never,
    ...(policy ? { policy } : {}),
  });
  return posts;
}

describe("RELAY_MESSENGER_DELIVERY", () => {
  it("is needed: Think posts the model's plain words to the chat by default", async () => {
    expect(await posted({ typingRefreshMs: 0 }, "and one more thing")).toEqual(["and one more thing"]);
  });

  it("posts none of the model's plain words, so only send makes Messages", async () => {
    expect(await posted({ ...RELAY_MESSENGER_DELIVERY, typingRefreshMs: 0 }, "and one more thing")).toEqual([]);
  });

  it("posts nothing for a turn with no words", async () => {
    expect(await posted({ ...RELAY_MESSENGER_DELIVERY, typingRefreshMs: 0 }, "")).toEqual([]);
  });
});
