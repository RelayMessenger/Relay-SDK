import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Relay from "@relaymessenger/sdk";
import { describe, expect, it } from "vitest";
import { runCLI } from "./program.js";

interface Sent { method: string; path: string; search: URLSearchParams; headers: Headers; body: any }

async function run(args: string[], reply: (call: Sent) => Response = () => Response.json({})) {
  const calls: Sent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = new Relay({ apiKey: "fixture-token", maxRetries: 0, fetch: async (input, init) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? "GET", path: url.pathname, search: url.searchParams,
      headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return reply(call);
  } });
  const code = await runCLI([...args, "--json"], {
    resolveClient: async () => ({ client, auth: { profile: "fixture", apiURL: client.baseURL,
      token: "fixture-token", tokenSource: "environment", configPath: "/unused" } }),
    stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
  });
  return { code, calls, stdout, stderr: stderr.join("") };
}

const sendParts = async (flags: string[]) => {
  const result = await run(["messages", "send", "--to", "ada", ...flags, "--idempotency-key", "key-1"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]!.path).toBe("/v1/messages");
  return result.calls[0]!.body.message;
};

const ATTACHMENT = "0b4a6f3e-1c2d-4e5f-8a9b-7c6d5e4f3a2b";

describe("message parts on every send", () => {
  it("keeps a text-only send exactly as before", async () => {
    expect(await sendParts(["--text", " Hello "])).toEqual({
      parts: [{ type: "text", value: "Hello" }], idempotency_key: "key-1",
    });
  });

  it("measures a mention in UTF-16 code units, after an emoji", async () => {
    const message = await sendParts(["--text", "👋 hi @atlas, meet Ada", "--mention", "@atlas"]);
    expect(message.parts).toEqual([{ type: "text", value: "👋 hi @atlas, meet Ada", mention: "atlas", mention_range: [6, 12] }]);
  });

  it("marks only a whole @handle, never one inside a longer handle", async () => {
    const message = await sendParts(["--text", "@bobby and @bob", "--mention", "bob"]);
    expect(message.parts).toEqual([{ type: "text", value: "@bobby and @bob", mention: "bob", mention_range: [11, 15] }]);
    const result = await run(["messages", "send", "--to", "ada", "--text", "@bobby only", "--mention", "bob"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Write @bob in --text");
    expect(result.calls).toHaveLength(0);
  });

  it("sends the handle lowercase, as Relay stores it, and finds it written in any case", async () => {
    const message = await sendParts(["--text", "hi @Bob!", "--mention", "Bob"]);
    expect(message.parts).toEqual([{ type: "text", value: "hi @Bob!", mention: "bob", mention_range: [3, 7] }]);
    // "İ" lowercases to two code units; the range still counts the text as sent.
    expect((await sendParts(["--text", "İ @Bob", "--mention", "bob"])).parts[0].mention_range).toEqual([2, 6]);
  });

  it("sends media by URL or attachment ID, a link, buttons, a place and a payment", async () => {
    expect((await sendParts(["--text", "Look", "--media", "https://example.com/a.png", "--media", ATTACHMENT])).parts).toEqual([
      { type: "text", value: "Look" },
      { type: "media", url: "https://example.com/a.png" },
      { type: "media", attachment_id: ATTACHMENT },
    ]);
    expect((await sendParts(["--link", "https://relayapp.im"])).parts).toEqual([{ type: "link", value: "https://relayapp.im" }]);
    expect((await sendParts(["--text", "Pick one", "--button", "Yes", "--button", "Docs=https://docs.relayapp.im/a=b"])).parts).toEqual([
      { type: "text", value: "Pick one" },
      { type: "buttons", items: [{ label: "Yes" }, { label: "Docs", url: "https://docs.relayapp.im/a=b" }] },
    ]);
    expect((await sendParts(["--place", "37.4422,-122.1615", "--place-name", "Philz Coffee", "--place-address", "101 Forest Ave"])).parts).toEqual([
      { type: "place", latitude: 37.4422, longitude: -122.1615, name: "Philz Coffee", address: "101 Forest Ave" },
    ]);
    expect((await sendParts(["--payment", "https://pay.relayapp.im/c/abc"])).parts).toEqual([
      { type: "payment", checkout_url: "https://pay.relayapp.im/c/abc" },
    ]);
  });

  it("takes a list picker, form, rich card and carousel as inline JSON or a JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-message-parts-"));
    const formFile = join(dir, "form.json");
    await writeFile(formFile, JSON.stringify({ title: "Book", pages: [{ id: "p1", title: "When", fields: [{ id: "date", type: "date", label: "Date" }] }] }));
    const selection = { title: "Size", options: [{ value: "s", label: "Small" }, { value: "l", label: "Large" }] };
    expect((await sendParts(["--selection", JSON.stringify(selection)])).parts).toEqual([{ type: "selection", ...selection }]);
    expect((await sendParts(["--text", "Fill this in", "--form", formFile])).parts).toEqual([
      { type: "text", value: "Fill this in" },
      { type: "form", title: "Book", pages: [{ id: "p1", title: "When", fields: [{ id: "date", type: "date", label: "Date" }] }] },
    ]);
    const card = { title: "Philz", description: "Coffee", suggestions: [{ type: "reply", label: "Go", id: "go" }] };
    expect((await sendParts(["--rich-card", JSON.stringify(card)])).parts).toEqual([{ type: "rich_card", ...card }]);
    const carousel = { card_width: "small", cards: [{ title: "A" }, { title: "B" }] };
    expect((await sendParts(["--carousel", JSON.stringify(carousel)])).parts).toEqual([{ type: "carousel", ...carousel }]);
  });

  it("sends every part from a --parts file, with a reply target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-message-parts-"));
    const file = join(dir, "parts.json");
    await writeFile(file, JSON.stringify([{ type: "text", value: "Here" }, { type: "media", url: "https://example.com/a.png" }]));
    const message = await sendParts(["--parts", file, "--reply-to", ATTACHMENT, "--reply-part-index", "1"]);
    expect(message).toEqual({
      parts: [{ type: "text", value: "Here" }, { type: "media", url: "https://example.com/a.png" }],
      reply_to: { message_id: ATTACHMENT, part_index: 1 },
      idempotency_key: "key-1",
    });
  });

  it.each([
    [[], "Nothing to send"],
    [["--parts", "[]"], "non-empty JSON array"],
    [["--parts", "[{\"type\":\"text\",\"value\":\"a\"}]", "--text", "b"], "leave out the other part flags"],
    [["--mention", "atlas"], "--mention needs --text"],
    [["--text", "hi", "--mention", "atlas"], "Write @atlas in --text"],
    [["--selection", "{\"title\":\"x\"}"], "--selection: selection needs exactly one of options or sections"],
    [["--selection", "/no/such/file.json"], "could not be read"],
    [["--rich-card", "{\"type\":\"carousel\"}"], "must be a rich_card part"],
    [["--place", "north"], "latitude,longitude"],
    [["--place-name", "Home"], "need --place"],
    [["--text", "hi", "--reply-part-index", "0"], "needs --reply-to"],
  ])("refuses %j before any request", async (flags, message) => {
    const result = await run(["messages", "send", "--to", "ada", ...flags]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls).toHaveLength(0);
  });

  it("carries parts and a reply on chats messages send and chats create", async () => {
    const sent = await run(["chats", "messages", "send", "chat-1", "--text", "Pick", "--button", "Yes", "--reply-to", ATTACHMENT, "--silent"]);
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.calls[0]!.path).toBe("/v1/chats/chat-1/messages");
    expect(sent.calls[0]!.body.message).toMatchObject({
      parts: [{ type: "text", value: "Pick" }, { type: "buttons", items: [{ label: "Yes" }] }],
      reply_to: { message_id: ATTACHMENT }, silent: true,
    });
    expect(sent.calls[0]!.body.message.idempotency_key).toMatch(/^[0-9a-f-]{36}$/u);

    const created = await run(["chats", "create", "--from", "echo", "--to", "ada", "--media", ATTACHMENT, "--idempotency-key", "k"]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.calls[0]!.body).toEqual({
      from: "echo", to: ["ada"], message: { parts: [{ type: "media", attachment_id: ATTACHMENT }], idempotency_key: "k" },
    });
  });
});
