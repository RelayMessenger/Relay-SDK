import { describe, expect, it, vi } from "vitest";
import { llm } from "@livekit/agents";
import type { Message, MessageSendParams } from "@relaymessenger/sdk";
import { relayChatContext, relayChatTools, type RelayChatClient } from "../src/index.js";

const CHAT = "chat-1";

const fakeRelay = (messages: Message[] = [], features: unknown[] = []) => {
  const send = vi.fn(async (_chatId: string, _body: MessageSendParams) => ({
    chat_id: CHAT,
    message: { id: "msg-1" },
  }));
  const list = vi.fn(async () => ({ data: messages }));
  const request = vi.fn(async () => ({ success: true, message: "Location request sent" }));
  const retrieve = vi.fn(async () => ({
    success: true,
    data: { type: "FeatureCollection", features },
  }));
  const relay = { chats: { messages: { send, list }, location: { request, retrieve } } };
  return { relay: relay as unknown as RelayChatClient, send, list, request, retrieve };
};

type ChatTool = ReturnType<typeof relayChatTools>[number];
const opts = {} as Parameters<ChatTool["execute"]>[1];

/** The tool the model calls by `name`, as LiveKit's ToolContext resolves it. */
const tool = (relay: RelayChatClient, name: string): ChatTool => {
  const found = new llm.ToolContext(relayChatTools(relay, CHAT)).getFunctionTool(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const sentParts = (send: ReturnType<typeof fakeRelay>["send"]) => {
  expect(send).toHaveBeenCalledTimes(1);
  const [chatId, body] = send.mock.calls[0]!;
  expect(chatId).toBe(CHAT);
  return body.message.parts;
};

describe("relayChatTools", () => {
  it("returns the seven named tools in LiveKit's array form", () => {
    const { relay } = fakeRelay();
    const list = relayChatTools(relay, CHAT);
    expect(Array.isArray(list)).toBe(true);
    const context = new llm.ToolContext(list);
    expect(Object.keys(context.functionTools).sort()).toEqual([
      "read_location", "request_location", "send_buttons", "send_link",
      "send_message", "send_place", "send_selection",
    ]);
  });

  it("send_message sends one text part", async () => {
    const { relay, send } = fakeRelay();
    const result = await tool(relay, "send_message").execute({ text: "Gate 22" }, opts);
    expect(result).toEqual({ status: "sent", message_id: "msg-1" });
    expect(sentParts(send)).toEqual([{ type: "text", value: "Gate 22" }]);
  });

  it("send_buttons sends the question and a buttons part", async () => {
    const { relay, send } = fakeRelay();
    await tool(relay, "send_buttons").execute({
      text: "Book it?",
      buttons: [{ label: "Yes" }, { label: "Pay", url: "https://example.com/pay" }],
    }, opts);
    expect(sentParts(send)).toEqual([
      { type: "text", value: "Book it?" },
      { type: "buttons", items: [{ label: "Yes" }, { url: "https://example.com/pay", label: "Pay" }] },
    ]);
  });

  it("send_buttons refuses six buttons without sending", async () => {
    const { relay, send } = fakeRelay();
    const buttons = Array.from({ length: 6 }, (_, index) => ({ label: `B${index}` }));
    await expect(tool(relay, "send_buttons").execute({ text: "Pick", buttons }, opts))
      .rejects.toBeInstanceOf(llm.ToolError);
    expect(send).not.toHaveBeenCalled();
  });

  it("send_selection sends the text and a selection part", async () => {
    const { relay, send } = fakeRelay();
    await tool(relay, "send_selection").execute({
      text: "Pick toppings",
      title: "Pizza toppings",
      multiple: false,
      options: [{ id: "cheese", label: "Cheese" }, { id: "olive", label: "Olive", subtitle: "Black" }],
    }, opts);
    expect(sentParts(send)).toEqual([
      { type: "text", value: "Pick toppings" },
      {
        type: "selection",
        title: "Pizza toppings",
        multiple: false,
        options: [
          expect.objectContaining({ id: "cheese", label: "Cheese" }),
          expect.objectContaining({ id: "olive", label: "Olive", subtitle: "Black" }),
        ],
      },
    ]);
  });

  it("send_selection refuses a title over 60 characters", async () => {
    const { relay, send } = fakeRelay();
    await expect(tool(relay, "send_selection").execute({
      title: "x".repeat(61), options: [{ id: "a", label: "A" }],
    }, opts)).rejects.toBeInstanceOf(llm.ToolError);
    expect(send).not.toHaveBeenCalled();
  });

  it("send_place sends a place part", async () => {
    const { relay, send } = fakeRelay();
    await tool(relay, "send_place").execute({
      latitude: 42.28, longitude: -83.74, name: "Diag", address: "Ann Arbor",
    }, opts);
    expect(sentParts(send)).toEqual([
      { type: "place", latitude: 42.28, longitude: -83.74, name: "Diag", address: "Ann Arbor" },
    ]);
  });

  it("send_place refuses a latitude out of range", async () => {
    const { relay, send } = fakeRelay();
    await expect(tool(relay, "send_place").execute({ latitude: 91, longitude: 0 }, opts))
      .rejects.toBeInstanceOf(llm.ToolError);
    expect(send).not.toHaveBeenCalled();
  });

  it("request_location asks this chat", async () => {
    const { relay, request } = fakeRelay();
    await expect(tool(relay, "request_location").execute({}, opts))
      .resolves.toEqual({ status: "requested" });
    expect(request).toHaveBeenCalledWith(CHAT);
  });

  it("read_location returns not_sharing, then latitude and longitude in that order", async () => {
    await expect(tool(fakeRelay().relay, "read_location").execute({}, opts))
      .resolves.toEqual({ status: "not_sharing" });
    const { relay, retrieve } = fakeRelay([], [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [-83.74, 42.28] },
      properties: { handle: "+15555550100", updated_at: "2026-10-07T12:00:00Z" },
    }]);
    await expect(tool(relay, "read_location").execute({}, opts)).resolves.toEqual({
      status: "sharing",
      locations: [{ handle: "+15555550100", latitude: 42.28, longitude: -83.74, updated_at: "2026-10-07T12:00:00Z" }],
    });
    expect(retrieve).toHaveBeenCalledWith(CHAT);
  });

  it("send_link sends a link part and refuses a non-URL", async () => {
    const { relay, send } = fakeRelay();
    await tool(relay, "send_link").execute({ url: "https://example.com/menu" }, opts);
    expect(sentParts(send)).toEqual([{ type: "link", value: "https://example.com/menu" }]);
    await expect(tool(relay, "send_link").execute({ url: "example dot com" }, opts)).rejects.toBeInstanceOf(llm.ToolError);
  });
});

const message = (id: string, isFromMe: boolean, parts: Message["parts"], extra: Partial<Message> = {}): Message => ({
  id,
  chat_id: CHAT,
  parts,
  is_system_message: false,
  is_from_me: isFromMe,
  delivery_status: "delivered",
  created_at: `2026-10-07T12:00:0${id.slice(-1)}Z`,
  updated_at: `2026-10-07T12:00:0${id.slice(-1)}Z`,
  ...extra,
} as Message);

describe("relayChatContext", () => {
  it("reads the newest page and returns it oldest first with roles", async () => {
    const newestFirst = [
      message("m3", true, [{ type: "text", value: "See you there", reactions: null }]),
      message("m2", false, [{ type: "place", latitude: 42.28, longitude: -83.74, name: "Diag", reactions: null }]),
      message("m1", false, [{ type: "text", value: "Where do we meet?", reactions: null }]),
      message("m0", false, null, { is_system_message: true }),
    ];
    const { relay, list } = fakeRelay(newestFirst);
    const chatCtx = await relayChatContext(relay, CHAT, 4);
    expect(list).toHaveBeenCalledWith(CHAT, { order: "desc", limit: 4 });
    const items = chatCtx.items as llm.ChatMessage[];
    expect(items.map((item) => [item.id, item.role])).toEqual([
      ["m1", "user"], ["m2", "user"], ["m3", "assistant"],
    ]);
    expect(items[0]!.textContent).toBe("Where do we meet?");
    expect(items[1]!.textContent).toContain("42.28");
    expect(items[1]!.textContent).toContain("Diag");
    expect(items[0]!.createdAt).toBe(Date.parse("2026-10-07T12:00:01Z"));
  });
});
