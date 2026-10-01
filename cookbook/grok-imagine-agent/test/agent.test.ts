import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RelayAPIError } from "@relaymessenger/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  answer, CHARACTER, MAX_REFUSALS, recentWindow, recoverChats, RETRY_LIMIT_MS, VIDEO_DEADLINE_MS, wordsOf, type RelayClient,
} from "../src/agent.js";
import { ProgressStore } from "../src/store.js";
import { retryAfter, Xai, type Media, type ResponseItem } from "../src/xai.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]);
const REFERENCE: Media = { bytes: PNG, contentType: "image/png", filename: "reference" };
const ATTACHMENT = "01993d50-ef7b-7b37-886b-23fd80c7ec10";

const call = (name: string, args: Record<string, string>, id = "call-1"): ResponseItem =>
  ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const say = (text: string): ResponseItem =>
  ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

/** A chat's messages, as Relay's REST API lists them for a FULL sync. */
type Listed = { id: string; is_from_me: boolean; text: string; at: string };

/** A Relay double that records sends and can fail the Nth send once. */
function relay(failSend?: number, history: Record<string, Listed[]> = {}) {
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
          if (sends === failSend) throw new RelayAPIError("Relay network request failed.");
          sent.push({ chatId, body });
          return { chat_id: chatId, message: { id: `message-${sends}` } } as never;
        }),
        list: vi.fn(async (chatId: string) => (history[chatId] ?? []).map((m) => ({
          id: m.id,
          chat_id: chatId,
          is_from_me: m.is_from_me,
          is_system_message: false,
          created_at: m.at,
          from_handle: { handle: m.is_from_me ? "diego" : "sam", display_name: m.is_from_me ? "Diego" : "Sam" },
          parts: [{ type: "text", value: m.text }],
        })) as never),
      },
      listChats: vi.fn(async () => Object.keys(history).map((id) => ({ id, is_group: false })) as never),
    },
    contactCard: {
      retrieve: vi.fn(async () => ({ contact_cards: [] })),
      update: vi.fn(async () => ({ handle: "diego", image_url: null })),
    },
  } satisfies RelayClient;
  return { client, sent };
}

/**
 * An xAI double: each /responses call returns the next output, every image
 * edit returns one PNG, and a video is done on its second status check.
 * `failOnce` makes the first request to that path reject as a dropped
 * connection would.
 */
function xai(
  outputs: ResponseItem[][],
  options: {
    failOnce?: string;
    videoStatus?: string;
    refuse?: (body: Record<string, unknown>) => boolean;
    /** Answers the Nth /responses call (1-based) with this failure instead. */
    respondFails?: Record<number, { status: number; headers?: Record<string, string> }>;
  } = {},
) {
  let responds = 0;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let failed = false;
  let polls = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url === "https://video.example.test/v.mp4") return new Response(PNG, { status: 200 });
    const path = url.replace("https://api.x.ai/v1", "");
    if (path === options.failOnce && !failed) {
      failed = true;
      throw new TypeError("fetch failed");
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, body: structuredClone(body) });
    if (path === "/responses" && options.refuse?.(body)) {
      return new Response(JSON.stringify({ error: "invalid request" }), { status: 400 });
    }
    const failure = path === "/responses" ? options.respondFails?.[++responds] : undefined;
    if (failure) return new Response(JSON.stringify({ error: "busy" }), failure);
    let result: unknown;
    if (path === "/responses") result = { output: outputs.shift() ?? [say("…")] };
    else if (path === "/videos/generations") result = { request_id: "video-1" };
    else if (path === "/videos/video-1") {
      polls += 1;
      result = { status: options.videoStatus ?? (polls >= 2 ? "done" : "pending"), video: { url: "https://video.example.test/v.mp4" } };
    } else result = { data: [{ b64_json: Buffer.from(PNG).toString("base64") }] };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client: new Xai({ apiKey: "test", fetch, pollMs: 1 }), requests };
}

const stores: ProgressStore[] = [];
const memory = () => {
  const store = new ProgressStore(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => stores.splice(0).forEach((store) => store.close()));

// Tests never reach xAI or Relay, even with a real XAI_API_KEY in the
// environment: every request goes to a double, and the real fetch is replaced.
beforeEach(() => {
  vi.stubGlobal("fetch", async (url: unknown) => {
    throw new Error(`tests never reach the network (${String(url)})`);
  });
});
afterEach(() => vi.unstubAllGlobals());

it("never reaches the network, even with a real key", async () => {
  const live = new Xai({ apiKey: process.env.XAI_API_KEY ?? "xai-test" });
  const failure = await live.respond("persona", [{ role: "user", content: "hi" }], []).catch((error: unknown) => error);
  expect(String((failure as Error).cause)).toContain("tests never reach the network (https://api.x.ai/v1/responses)");
});

/** A sleep that returns at once and records each wait. */
const waits = () => {
  const recorded: number[] = [];
  return { recorded, sleep: async (ms: number) => void recorded.push(ms) };
};

/** Every function call in a chat's history has a function_call_output. */
function unanswered(items: ResponseItem[]): string[] {
  const outputs = new Set(items.flatMap((item) => ("type" in item && item.type === "function_call_output" ? [item.call_id] : [])));
  return items.flatMap((item) => ("type" in item && item.type === "function_call" && !outputs.has(item.call_id) ? [item.call_id] : []));
}

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
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE, sleep: waits().sleep };
    const incoming = { eventId: "event-2", chatId: "chat", text: "selfie please" };

    await answer(deps, incoming); // the retry resumes after the failed send
    await answer(deps, incoming); // later deliveries of the same event do nothing
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
        relayClient.attachments.upload.mockRejectedValueOnce(new RelayAPIError("Relay network request failed."));
      }
      const { client: xaiClient, requests } = xai([[call("send_picture", { scene: "A selfie" })], [say("Here!")]]);
      const { recorded, sleep } = waits();
      const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE, sleep };
      const incoming = { eventId: `event-${failure}`, chatId: "chat", text: "selfie" };

      await answer(deps, incoming);
      expect(recorded, failure).toEqual([1_000]);

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

  it("hands malformed tool arguments back to Grok as an error it can correct", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    const bad: ResponseItem = { type: "function_call", call_id: "call-bad", name: "send_picture", arguments: "{scene: oops" };
    const { client: xaiClient, requests } = xai([[bad], [say("Let me try that again.")]]);

    await answer(
      { relay: relayClient, xai: xaiClient, store, reference: REFERENCE },
      { eventId: "event-json", chatId: "chat", text: "selfie" },
    );

    const output = store.items("chat").find((item) => "type" in item && item.type === "function_call_output");
    expect(output).toMatchObject({ call_id: "call-bad" });
    expect(JSON.stringify(output)).toContain("not valid JSON");
    expect(requests.filter((r) => r.path === "/responses")).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it("resumes a video after a dropped connection without requesting it again, and prunes its bytes", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    const { client: xaiClient, requests } = xai(
      [[call("send_video", { scene: "The Diag", action: "Digs up an acorn" })], [say("Watch this!")]],
      { failOnce: "/videos/video-1" },
    );
    const { recorded, sleep } = waits();
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE, sleep };
    const incoming = { eventId: "event-video", chatId: "chat", text: "video please" };

    await answer(deps, incoming);
    expect(recorded).toEqual([1_000]);

    expect(requests.filter((r) => r.path === "/videos/generations")).toHaveLength(1);
    expect(requests.filter((r) => r.path === "/images/edits")).toHaveLength(1);
    expect(sent.map((s) => (s.body as { message: { idempotency_key: string } }).message.idempotency_key))
      .toEqual(["event-video:call-1", "event-video:1:text"]);
    expect(store.mediaCount()).toBe(0);
  });

  it("tells Grok a video failed once its deadline passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const store = memory();
      const { client: relayClient } = relay();
      const { client: xaiClient } = xai(
        [[call("send_video", { scene: "The Diag", action: "Waves" })], [say("Sorry, no video this time.")]],
        { videoStatus: "pending" },
      );
      store.saveVideo("event-late:call-1", "video-1", Date.now() - 1);
      await answer(
        { relay: relayClient, xai: xaiClient, store, reference: REFERENCE },
        { eventId: "event-late", chatId: "chat", text: "video" },
      );
      const output = store.items("chat").find((item) => "type" in item && item.type === "function_call_output");
      expect(JSON.stringify(output)).toContain("did not finish in time");
      expect(VIDEO_DEADLINE_MS).toBe(600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends Grok a recent window that starts at a person's message", () => {
    const items: ResponseItem[] = [];
    for (let i = 0; i < 30; i++) {
      items.push({ role: "user", content: `message ${i}` }, call("send_picture", { scene: "x" }, `call-${i}`),
        { type: "function_call_output", call_id: `call-${i}`, output: "Sent." });
    }
    const window = recentWindow(items, 40);
    expect(window.length).toBeLessThanOrEqual(41);
    expect(window[0]).toEqual({ role: "developer", content: "Earlier messages in this chat are not shown." });
    expect(window[1]).toMatchObject({ role: "user" });
    expect(window.at(-1)).toEqual(items.at(-1));
  });

  it("on a FULL sync rebuilds the chat from Relay and answers a missed message once", async () => {
    const store = memory();
    const history = {
      chat: [
        { id: "m1", is_from_me: false, text: "hi", at: "2026-10-01T10:00:00Z" },
        { id: "m2", is_from_me: true, text: "hey!", at: "2026-10-01T10:00:05Z" },
        { id: "m3", is_from_me: false, text: "selfie?", at: "2026-10-01T10:05:00Z" },
      ],
    };
    const { client: relayClient, sent } = relay(undefined, history);
    const { client: xaiClient, requests } = xai([[say("Here I am!")]]);
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE };
    const describe = (message: { is_from_me: boolean; parts?: unknown }) =>
      wordsOf((message.parts ?? []) as { type: string; value?: unknown }[], "Sam", false);

    await recoverChats(deps, describe as never);
    await recoverChats(deps, describe as never);
    await answer(deps, { eventId: "late-event", chatId: "chat", messageId: "m3", text: "selfie?" });

    expect(requests.filter((r) => r.path === "/responses")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(store.items("chat").slice(0, 3)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey!" },
      { role: "user", content: "selfie?" },
    ]);
  });

  it("gives up on an event after its third lasting refusal, says so, and lets the next message through", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    let broken = true;
    let noticeWorks = true;
    const { client: xaiClient } = xai([[say("Sorry, I couldn't do that one.")], [say("Hi again!")]], {
      // xAI refuses every normal turn while broken; the failure notice has no tools.
      refuse: (body) => (broken && (body.tools as unknown[]).length > 0) || (!noticeWorks && (body.tools as unknown[]).length === 0),
    });
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE };
    const first = { eventId: "event-stuck", chatId: "chat", text: "do the impossible" };

    expect(MAX_REFUSALS).toBe(3);
    await expect(answer(deps, first)).rejects.toThrow("answered 400");
    await expect(answer(deps, first)).rejects.toThrow("answered 400");
    await answer(deps, first); // the third delivery is acknowledged
    expect(store.failed("event-stuck")).toBe(true);
    expect(sent.map((s) => s.body)).toEqual([
      { message: { parts: [{ type: "text", value: "Sorry, I couldn't do that one." }], idempotency_key: "event-stuck:failed" } },
    ]);

    await answer(deps, first); // a fourth delivery does nothing
    expect(sent).toHaveLength(1);

    broken = false;
    noticeWorks = false;
    await answer(deps, { eventId: "event-next", chatId: "chat", text: "hi" });
    expect(sent.at(-1)!.body).toEqual(
      { message: { parts: [{ type: "text", value: "Hi again!" }], idempotency_key: "event-next:0:text" } },
    );
  });

  it("acknowledges a failed event even when Grok cannot send the notice", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    const { client: xaiClient } = xai([], { refuse: () => true });
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE };
    const stuck = { eventId: "event-dead", chatId: "chat", text: "hello?" };

    for (let delivery = 1; delivery < MAX_REFUSALS; delivery++) await expect(answer(deps, stuck)).rejects.toThrow();
    await answer(deps, stuck);
    expect(store.failed("event-dead")).toBe(true);
    expect(sent).toEqual([]);
  });
  it("gives a tool that fails for good an output, so Grok answers and the history stays valid", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    relayClient.attachments.create.mockRejectedValue(new RelayAPIError("The file is too large.", { status: 413 }));
    const { client: xaiClient, requests } = xai([[call("send_picture", { scene: "A selfie" })], [say("My camera broke, sorry!")]]);

    await answer(
      { relay: relayClient, xai: xaiClient, store, reference: REFERENCE },
      { eventId: "event-big", chatId: "chat", text: "selfie" },
    );

    expect(unanswered(store.items("chat"))).toEqual([]);
    const second = requests.filter((r) => r.path === "/responses")[1]!.body.input as ResponseItem[];
    expect(second.at(-1)).toEqual({ type: "function_call_output", call_id: "call-1", output: "It did not work: The file is too large." });
    expect(sent.map((s) => s.body)).toEqual([
      { message: { parts: [{ type: "text", value: "My camera broke, sorry!" }], idempotency_key: "event-big:1:text" } },
    ]);
  });

  it("closes a tool call with its error when retries run out, so no later request carries it unanswered", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    relayClient.attachments.upload.mockRejectedValue(new RelayAPIError("Relay network request failed."));
    const { client: xaiClient, requests } = xai([[call("send_picture", { scene: "A selfie" })], [say("Hi Sam!")]]);
    const { recorded, sleep } = waits();
    const deps = { relay: relayClient, xai: xaiClient, store, reference: REFERENCE, sleep };

    await expect(answer(deps, { eventId: "event-down", chatId: "chat", text: "selfie" })).rejects.toThrow("network");
    expect(recorded.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RETRY_LIMIT_MS);
    expect(recorded.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(unanswered(store.items("chat"))).toEqual([]);
    expect(store.items("chat")).toContainEqual(
      { type: "function_call_output", call_id: "call-1", output: "It did not work: Relay network request failed." },
    );

    await answer(deps, { eventId: "event-after", chatId: "chat", text: "hi" });
    const last = requests.filter((r) => r.path === "/responses").at(-1)!.body.input as ResponseItem[];
    expect(unanswered(last)).toEqual([]);
    expect(sent.at(-1)!.body).toEqual(
      { message: { parts: [{ type: "text", value: "Hi Sam!" }], idempotency_key: "event-after:0:text" } },
    );
  });

  it("retries a passing xAI failure in place, honouring Retry-After, without counting a refusal", async () => {
    const store = memory();
    const { client: relayClient, sent } = relay();
    const { client: xaiClient, requests } = xai([[say("Hey!")]], {
      respondFails: { 1: { status: 503 }, 2: { status: 429, headers: { "retry-after": "7" } }, 3: { status: 408 } },
    });
    const { recorded, sleep } = waits();

    await answer(
      { relay: relayClient, xai: xaiClient, store, reference: REFERENCE, sleep },
      { eventId: "event-busy", chatId: "chat", text: "hey" },
    );

    expect(recorded).toEqual([1_000, 7_000, 4_000]);
    expect(requests.filter((r) => r.path === "/responses")).toHaveLength(4);
    expect(sent.map((s) => s.body)).toEqual([
      { message: { parts: [{ type: "text", value: "Hey!" }], idempotency_key: "event-busy:0:text" } },
    ]);
    expect(store.event("event-busy")).toMatchObject({ done: true, refusals: 0 });
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(retryAfter("12", now)).toBe(12_000);
    expect(retryAfter("Thu, 01 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfter("soon", now)).toBeUndefined();
    expect(retryAfter(null, now)).toBeUndefined();
  });
});

describe("ProgressStore", () => {
  it("adds the newer event columns to a state.db from an older version, and opens it again", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-imagine-store-"));
    try {
      const path = join(dir, "state.db");
      // The events table as the first release of this recipe created it.
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE events (
        event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0);
        INSERT INTO events (event_id, chat_id) VALUES ('event-old', 'chat');`);
      old.close();

      for (const pass of [1, 2]) {
        const store = new ProgressStore(path);
        try {
          expect(store.begin(`event-new-${pass}`, "chat", { role: "user", content: "hi" }, `message-${pass}`), `pass ${pass}`).toBe(true);
          expect(store.hasMessage(`message-${pass}`)).toBe(true);
          expect(store.refused("event-old")).toBe(pass);
          store.fail(`event-new-${pass}`);
          expect(store.failed(`event-new-${pass}`)).toBe(true);
          expect(store.failed("event-old")).toBe(false);
        } finally {
          store.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
