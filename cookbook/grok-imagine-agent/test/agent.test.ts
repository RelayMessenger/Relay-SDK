import { afterEach, describe, expect, it, vi } from "vitest";

import { answer, CHARACTER, type RelayClient } from "../src/agent.js";
import { ProgressStore } from "../src/store.js";
import { Xai, type Media, type ResponseItem } from "../src/xai.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]);
const REFERENCE: Media = { bytes: PNG, contentType: "image/png", filename: "reference" };
const ATTACHMENT = "01993d50-ef7b-7b37-886b-23fd80c7ec10";

const call = (name: string, args: Record<string, string>, id = "call-1"): ResponseItem =>
  ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const say = (text: string): ResponseItem =>
  ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

/** A Relay double that records sends and can fail the Nth send once. */
function relay(failSend?: number) {
  const sent: { chatId: string; body: unknown }[] = [];
  let sends = 0;
  const client = {
    attachments: {
      create: vi.fn(async () => ({
        attachment_id: ATTACHMENT,
        upload_url: "https://upload.example.test/object",
        download_url: "https://media.example.test/object",
        http_method: "PUT" as const,
        expires_at: "2026-09-01T12:05:00Z",
        required_headers: {},
      })),
      upload: vi.fn(async () => undefined),
    },
    chats: {
      messages: {
        send: vi.fn(async (chatId: string, body: unknown) => {
          sends += 1;
          if (sends === failSend) throw new Error("connection reset");
          sent.push({ chatId, body });
          return { chat_id: chatId, message: { id: `message-${sends}` } } as never;
        }),
      },
    },
    contactCard: {
      retrieve: vi.fn(async () => ({ contact_cards: [] })),
      update: vi.fn(async () => ({ handle: "diego", image_url: null })),
    },
  } satisfies RelayClient;
  return { client, sent };
}

/** An xAI double: each /responses call returns the next output; every image edit returns one PNG. */
function xai(outputs: ResponseItem[][]) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.x.ai/v1", "");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ path, body: structuredClone(body) });
    const result = path === "/responses"
      ? { output: outputs.shift() ?? [say("…")] }
      : { data: [{ b64_json: Buffer.from(PNG).toString("base64") }] };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client: new Xai({ apiKey: "test", fetch }), requests };
}

const stores: ProgressStore[] = [];
const memory = () => {
  const store = new ProgressStore(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("answer", () => {
  it("sends the picture Grok asks for, drawn from the reference, then Grok's words", async () => {
    const { client: relayClient, sent } = relay();
    const { client: xaiClient, requests } = xai([[call("send_picture", { scene: "A selfie on the Diag" })], [say("There you go!")]]);

    await answer(
      { relay: relayClient, xai: xaiClient, store: memory(), reference: REFERENCE },
      { eventId: "event-1", chatId: "chat", text: "send me a selfie" },
    );

    expect(sent.map((s) => s.body)).toEqual([
      { message: { parts: [{ type: "media", attachment_id: ATTACHMENT }], idempotency_key: "event-1:call-1" } },
      { message: { parts: [{ type: "text", value: "There you go!" }], idempotency_key: "event-1:1:text" } },
    ]);
    const edit = requests.find((r) => r.path === "/images/edits")!.body;
    expect(edit.prompt).toContain(CHARACTER);
    expect(edit.prompt).toContain("A selfie on the Diag");
    // xAI's own image-edit example: image is { url, type: "image_url" }.
    expect(edit.image).toEqual({ url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, type: "image_url" });
    expect(requests.find((r) => r.path === "/responses")!.body.model).toBe("grok-4.7");
  });

  it("resumes a redelivered event without repeating the words, a Grok step, or the picture", async () => {
    const store = memory();
    // The second send (Grok's words) fails once, as a dropped connection would.
    const { client: relayClient, sent } = relay(2);
    const { client: xaiClient, requests } = xai([[call("send_picture", { scene: "A selfie" })], [say("There you go!")]]);
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE };
    const incoming = { eventId: "event-2", chatId: "chat", text: "selfie please" };

    await expect(answer(deps, incoming)).rejects.toThrow("connection reset");
    await answer(deps, incoming);
    await answer(deps, incoming);

    expect(requests.filter((r) => r.path === "/responses")).toHaveLength(2);
    expect(requests.filter((r) => r.path === "/images/edits")).toHaveLength(1);
    expect(sent.map((s) => (s.body as { message: { idempotency_key: string } }).message.idempotency_key))
      .toEqual(["event-2:call-1", "event-2:1:text"]);
    const userTurns = store.items("chat").filter((item) => "role" in item && item.role === "user");
    expect(userTurns).toEqual([{ role: "user", content: "selfie please" }]);
  });

  it("never makes or uploads a picture twice when its send or upload fails", async () => {
    for (const failure of ["send", "upload"] as const) {
      const store = memory();
      const { client: relayClient, sent } = relay(failure === "send" ? 1 : undefined);
      if (failure === "upload") {
        relayClient.attachments.upload.mockRejectedValueOnce(new Error("upload reset"));
      }
      const { client: xaiClient, requests } = xai([[call("send_picture", { scene: "A selfie" })], [say("Here!")]]);
      const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE };
      const incoming = { eventId: `event-${failure}`, chatId: "chat", text: "selfie" };

      await expect(answer(deps, incoming)).rejects.toThrow();
      await answer(deps, incoming);

      expect(requests.filter((r) => r.path === "/images/edits"), failure).toHaveLength(1);
      expect(relayClient.attachments.create, failure).toHaveBeenCalledTimes(failure === "send" ? 1 : 2);
      expect(sent.filter((s) => JSON.stringify(s.body).includes(ATTACHMENT)), failure).toHaveLength(1);
    }
  });

  it("sends nothing when Grok stays silent in a group chat", async () => {
    const { client: relayClient, sent } = relay();
    const { client: xaiClient, requests } = xai([[call("stay_silent", {})]]);

    await answer(
      { relay: relayClient, xai: xaiClient, store: memory(), reference: REFERENCE },
      { eventId: "event-3", chatId: "group", text: "Sam (in a group chat): lunch at noon?" },
    );

    expect(sent).toEqual([]);
    expect(requests.filter((r) => r.path === "/responses")).toHaveLength(1);
  });
});
