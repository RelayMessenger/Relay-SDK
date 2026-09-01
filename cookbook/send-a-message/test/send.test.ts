import { describe, expect, it, vi } from "vitest";

import { relayApiOrigin } from "../src/config.js";
import { sendTextMessage } from "../src/send.js";

describe("send a Message", () => {
  it("accepts HTTPS or loopback only for Agent Tokens", () => {
    expect(relayApiOrigin("https://api.staging.relayapp.im"))
      .toBe("https://api.staging.relayapp.im");
    expect(relayApiOrigin("http://127.0.0.1:8787"))
      .toBe("http://127.0.0.1:8787");
    expect(() => relayApiOrigin("http://example.com")).toThrow(/HTTPS/);
  });

  it("sends one idempotent text Message", async () => {
    const send = vi.fn(async () => ({ message: { id: "sent-id" } }));

    await sendTextMessage({
      chats: { messages: { send } },
    }, {
      chatId: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      idempotencyKey: "relay-example:text:42",
      text: "Hello",
    });

    expect(send).toHaveBeenCalledWith(
      "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      {
        message: {
          parts: [{ type: "text", value: "Hello" }],
          idempotency_key: "relay-example:text:42",
        },
      },
    );
  });
});
