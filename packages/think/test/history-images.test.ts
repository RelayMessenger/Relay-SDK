import { convertToModelMessages, type UIMessage } from "ai";
import { afterEach, expect, it, vi } from "vitest";

import { withInboundMedia, withRecentHistoryImages } from "../src/attachments";
import { createRelayClient } from "../src/typing";

const relay = () => createRelayClient({ RELAY_AGENT_TOKEN: "fixture", RELAY_API_ORIGIN: "https://api.example.test" });
const image = (id: string, mime_type = "image/png") => ({ id, filename: "photo.png", mime_type });
function user(id: string, text: string, attachments = [] as ReturnType<typeof image>[]): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }], metadata: { turnMetadata: { message: { id, attachments } } } };
}

// Only the authenticated metadata endpoint knows the fresh, unsigned download location.
function network() {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url.pathname);
    const id = url.pathname.split("/").at(-1)!;
    if (url.host === "api.example.test" && request.headers.get("authorization") === "Bearer fixture") {
      if (id === "missing") return new Response(null, { status: 404 });
      return Response.json({ id, filename: "photo.png", content_type: "image/png", status: "complete",
        size_bytes: id === "large" ? 64 * 1024 * 1024 : id.length, download_url: `https://files.example.test/fresh/${id}` });
    }
    if (url.host === "files.example.test" && !request.headers.has("authorization")) {
      if (id === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return new Response(id);
    }
    throw new Error("Unexpected attachment request");
  });
  return requests;
}
afterEach(() => vi.unstubAllGlobals());

it("places fresh image bytes on their original turns without changing the stored history", async () => {
  const caption = "Thoughts?\nAttachments:\n- photo.png (image/png)";
  const history: UIMessage[] = [user("1", caption, [image("old")]),
    { id: "2", role: "assistant", parts: [{ type: "text", text: "What changed?" }] },
    user("3", caption, [image("new")]), user("4", "What do you think now?", [image("current")])];
  const stored = structuredClone(history);
  const messages = withInboundMedia(await convertToModelMessages(history), {
    parts: [{ type: "file", mediaType: "image/jpeg", data: Uint8Array.of(42) }], unreadable: [],
  });
  const requests = network();
  const result = await withRecentHistoryImages(messages, history, relay());
  const expectedFile = (id: string) => ({ type: "file", filename: "photo.png", mediaType: "image/png", data: new TextEncoder().encode(id) });
  expect(result[0]!.content).toEqual([{ type: "text", text: caption }, expectedFile("old")]);
  expect(result[2]!.content).toEqual([{ type: "text", text: caption }, expectedFile("new")]);
  expect(result[1]).toEqual(messages[1]);
  expect(result[3]).toEqual(messages[3]);
  expect(requests).not.toContain("/v1/attachments/current");
  expect(history).toEqual(stored);
  expect(messages[0]!.content).toHaveLength(1);
});

it("refreshes at most three images, newest messages first and in attachment order within a message", async () => {
  const history = [user("1", "older", [image("skipped")]), user("2", "earlier", [image("a"), image("b")]),
    user("3", "latest", [image("video", "video/mp4"), image("c"), image("d")]), user("4", "now")];
  const requests = network();
  const result = await withRecentHistoryImages(await convertToModelMessages(history), history, relay());
  expect(requests.filter(path => path.startsWith("/v1/attachments/")).sort()).toEqual([
    "/v1/attachments/a", "/v1/attachments/c", "/v1/attachments/d",
  ]);
  expect(result[2]!.content).toMatchObject([{ text: "latest" },
    { data: new TextEncoder().encode("c") }, { data: new TextEncoder().encode("d") }]);
});

it("counts all twenty preceding history messages, including assistant turns", async () => {
  const filler = Array.from({ length: 19 }, (_, i): UIMessage => ({
    id: `assistant-${i}`, role: "assistant", parts: [{ type: "text", text: "reply" }],
  }));
  const history = [user("1", "outside", [image("outside")]), user("2", "edge", [image("edge")]), ...filler, user("3", "now")];
  const requests = network();
  await withRecentHistoryImages(await convertToModelMessages(history), history, relay());
  expect(requests).toEqual(["/v1/attachments/edge", "/fresh/edge"]);
});

it.each(["missing", "large", "timeout"])("keeps the text when an image is %s and still attaches its sibling", async (bad) => {
  const history = [user("1", "album", [image(bad), image("ok")]), user("2", "now")];
  const requests = network();
  const result = await withRecentHistoryImages(await convertToModelMessages(history), history, relay());
  expect(result[0]!.content).toMatchObject([{ text: "album" }, { type: "file", data: new TextEncoder().encode("ok") }]);
  if (bad === "large") expect(requests).not.toContain("/fresh/large");
});

it("does not attach another row's bytes when the stored and model histories diverge", async () => {
  const history = [user("1", "earlier", [image("wrong")]), user("2", "now")];
  const messages = await convertToModelMessages([user("3", "other"), history[1]!]);
  const requests = network();
  expect(await withRecentHistoryImages(messages, history, relay())).toEqual(messages);
  expect(requests).toEqual([]);
});
