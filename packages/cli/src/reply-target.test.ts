import { describe, expect, it } from "vitest";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { bridgeTurn } from "./bridge-turn.js";
import { inboundMediaPrompt } from "./inbound-media.js";

const TARGET = "01993d50-ef7b-7b37-886b-23fd80c7ec90";
const options = { token: "agent-token", apiURL: "https://api.example" };

const reply = (replyTo?: { message_id: string; part_index?: number }) => ({
  event_type: "message.received", event_id: "reply-event",
  data: {
    id: "reply-message", direction: "inbound", chat: { id: "chat" },
    sender_handle: { handle: "alice", kind: "user" },
    parts: [{ type: "text", value: "what did you mean by this?", reactions: null }],
    ...(replyTo ? { reply_to: replyTo } : {}),
  },
} as RelayWebhookEvent);

const target = {
  id: TARGET, chat_id: "chat", is_from_me: true, is_system_message: false,
  from_handle: { handle: "relay", display_name: "Relay" },
  parts: [
    { type: "text", value: "The flight lands at 6.", reactions: null },
    { type: "text", value: "Take the long way round the lake.", reactions: null },
  ],
};

describe("a person's swipe-reply reaches the coding agent", () => {
  it("names the bubble swiped, who sent it and what it says", async () => {
    const reads: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      reads.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
      return Response.json(target);
    };
    const prompt = await inboundMediaPrompt(bridgeTurn(reply({ message_id: TARGET, part_index: 1 }))!, { ...options, fetch });
    expect(reads).toEqual([`https://api.example/v1/messages/${TARGET} Bearer agent-token`]);
    const [text, line] = prompt.text.split("\n");
    expect(text).toBe("what did you mean by this?");
    expect(JSON.parse(line!.slice(line!.indexOf("{")))).toEqual({
      reply_to: { id: TARGET, from: "you", part_index: 1, text: "Take the long way round the lake." },
    });
  });

  it("names the target by id when it cannot be read", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response("gone", { status: 404 });
    const prompt = await inboundMediaPrompt(bridgeTurn(reply({ message_id: TARGET, part_index: 0 }))!, { ...options, fetch });
    expect(prompt.text).toContain(`{"reply_to":{"id":"${TARGET}","unavailable":true}}`);
  });

  it("reads nothing for a Message that is not a reply", async () => {
    let reads = 0;
    const fetch: typeof globalThis.fetch = async () => { reads += 1; return Response.json(target); };
    const prompt = await inboundMediaPrompt(bridgeTurn(reply())!, { ...options, fetch });
    expect(prompt.text).toBe("what did you mean by this?");
    expect(reads).toBe(0);
  });
});
