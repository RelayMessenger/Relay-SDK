import { afterEach, describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod";

// @cloudflare/think loads cloudflare:workers, which exists only in a Worker.
// action() wraps its config; these tests call the config's execute.
vi.mock("@cloudflare/think", () => ({ action: (config: unknown) => ({ config }) }));

import {
  executeRelayReaction,
  relayTurnSettled,
  executeRelaySend,
  type RelayActionDependencies,
  sendInputSchema,
  type SendInput,
} from "../src/actions";
import { RelayGenerationActivities } from "../src/activity";
import { abortableDelay, type RelayClientEnv } from "../src/typing";
import { ActivityServer } from "./activity-fixture";
import { RelayCardRefused } from "../src/cards";
import type { StepResult, ToolSet } from "ai";

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const SENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";
const ATTACHMENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";

function env(): RelayClientEnv {
  return {
    RELAY_AGENT_TOKEN: "relay-test-token",
    RELAY_API_ORIGIN: "https://api.example.test",
  };
}

/** A WAV of 4 bytes of 24 kHz mono 16-bit audio: 1 ms. */
function wav(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 40, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 4, true);
  bytes.set([1, 2, 3, 4], 44);
  return bytes;
}

function dependencies(
  irreversible: boolean[] = [],
  compose: RelayActionDependencies["compose"] = async () => undefined,
  tasks: Promise<void>[] = [],
): RelayActionDependencies {
  return {
    env: env(),
    activities: new RelayGenerationActivities(),
    turn: () => ({ chatId: CHAT_ID, eventId: MESSAGE_ID }),
    signal: (signal) => signal,
    assertCurrentTurn: () => undefined,
    setIrreversibleSend: (active) => irreversible.push(active),
    waitUntil: (task) => tasks.push(task),
    runChosenAction: (_actionName, operation) => operation(),
    compose,
    media: {
      image: async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" }),
      voiceMemo: async () => ({ bytes: wav(), contentType: "audio/x-wav", durationMs: 1 }),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Relay send Action", () => {
  it("emits a Vertex-compatible root OBJECT function schema", () => {
    const schema = toJSONSchema(sendInputSchema);
    expect(schema.type).toBe("object");
    expect(schema.properties?.kind).toMatchObject({
      enum: ["text", "image", "voice_memo", "link", "place", "payment", "rich_card", "carousel"],
    });
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
  });

  it("takes a status only in the model's words, only while it makes an image or voice memo", () => {
    expect(sendInputSchema.safeParse({
      kind: "image", prompt: "tiny tower", activity: "Drawing a tower", activity_emoji: "🗼",
    }).success).toBe(true);
    expect(sendInputSchema.safeParse({
      kind: "voice_memo", text: "hi", activity: "Recording hi",
    }).success).toBe(true);
    // Relay's chat activity limit: 1 to 21 characters.
    expect(sendInputSchema.safeParse({
      kind: "image", prompt: "tiny tower", activity: "Drawing a very tall tower",
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "hi", activity: "Typing" }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "image", prompt: "tiny tower", activity_emoji: "🗼",
    }).success).toBe(false);
  });

  it("enforces fields by send kind without a root union", () => {
    expect(sendInputSchema.safeParse({
      kind: "text",
      text: "hello",
    }).success).toBe(true);
    expect(sendInputSchema.safeParse({
      kind: "image",
      prompt: "tiny tower",
      caption: "made this",
    }).success).toBe(true);
    expect(sendInputSchema.safeParse({
      kind: "voice_memo",
      text: "yo",
      style: "casual",
    }).success).toBe(true);
    expect(sendInputSchema.safeParse({
      kind: "image",
      text: "wrong field",
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "text",
      text: "hello",
      prompt: "wrong field",
    }).success).toBe(false);
  });

  it("paces composition and commits one idempotent text Message", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/messages")) {
        return Response.json({
          chat_id: CHAT_ID,
          message: { id: SENT_ID },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const sending = executeRelaySend(dependencies(), {
      kind: "text",
      text: "yeah, absolutely",
    });
    await expect(sending).resolves.toEqual({
      status: "sent",
      kind: "text",
      messageId: SENT_ID,
    });

    expect(calls.map(({ url, init }) => [
      new URL(url).pathname,
      init.method,
    ])).toEqual([
      [`/v1/chats/${CHAT_ID}/messages`, "POST"],
    ]);
    const messageRequest = calls[0]!;
    expect(new Headers(messageRequest.init.headers).get("idempotency-key"))
      .toBe(`relay-agent:${MESSAGE_ID}`);
    expect(JSON.parse(String(messageRequest.init.body))).toEqual({
      message: {
        parts: [{ type: "text", value: "yeah, absolutely" }],
        idempotency_key: `relay-agent:${MESSAGE_ID}`,
      },
    });
  });

  it("carries buttons under a text Message, and only under text", async () => {
    expect(sendInputSchema.safeParse({
      kind: "text",
      text: "Which time works?",
      buttons: [{ label: "9am" }, { label: "Open calendar", url: "https://cal.example/x" }],
    }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "text", text: "x", buttons: [] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "x", buttons: [{ label: "y".repeat(81) }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "x", buttons: [{ label: "a", id: "a" }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "x", buttons: [{ label: "a", url: "ftp://a" }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "image", prompt: "a cat", buttons: [{ label: "a" }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "x", buttons: [{ label: "Next" }], one_time: false }).success).toBe(false);
    const schema = toJSONSchema(sendInputSchema, { io: "input" }) as { oneOf?: unknown; properties?: Record<string, { description?: string }> };
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties?.buttons?.description).toContain("Send buttons when your message ends with a question");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
    await expect(executeRelaySend(dependencies(), {
      kind: "text",
      text: "Which time works?",
      buttons: [{ label: "9am" }, { label: "Open calendar", url: "https://cal.example/x" }],
    })).resolves.toEqual({ status: "sent", kind: "text", messageId: SENT_ID });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      message: {
        parts: [
          { type: "text", value: "Which time works?" },
          { type: "buttons", items: [{ label: "9am" }, { label: "Open calendar", url: "https://cal.example/x" }] },
        ],
        idempotency_key: `relay-agent:${MESSAGE_ID}`,
      },
    });
  });

  it("asks a selection question: the title heads the card, text is optional", async () => {
    const options = [{ value: "tokyo", label: "Tokyo" }, { value: "zurich", label: "Zurich" }];
    expect(sendInputSchema.safeParse({ kind: "text", title: "Cities", text: "Pick some.", selection: options }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "text", title: "Cities", selection: options }).success).toBe(true);
    // A selection without its title is refused, even with text.
    expect(sendInputSchema.safeParse({ kind: "text", text: "Which cities?", selection: options }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", selection: options }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", title: "  ", selection: options }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", title: "t".repeat(61), selection: options }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "Hi", title: "Cities" }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "text", title: "Which?", selection: options, buttons: [{ label: "Later" }],
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", title: "Which?", selection: [] }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "text", title: "Which?",
      selection: Array.from({ length: 26 }, (_, index) => ({ value: `o${index}`, label: `O${index}` })),
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "text", title: "Which?", selection: [{ value: "-bad", label: "Bad" }],
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "text", title: "Which?", selection: [{ value: "a", label: "A" }, { value: "a", label: "B" }],
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "image", prompt: "a cat", title: "x", selection: options }).success).toBe(false);
    const schema = toJSONSchema(sendInputSchema, { io: "input" }) as { properties?: Record<string, { description?: string }> };
    expect(schema.properties?.selection?.description).toContain("Put the question in `title` (1 to 60 characters");
    expect(JSON.stringify(schema)).not.toContain("nonblank text");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
    await expect(executeRelaySend(dependencies(), sendInputSchema.parse({
      kind: "text",
      title: "  Cities  ",
      selection: options,
    }) as SendInput)).resolves.toEqual({ status: "sent", kind: "text", messageId: SENT_ID });
    await expect(executeRelaySend(dependencies(), {
      kind: "text",
      text: "Pick any.",
      title: "Cities",
      selection: options,
    })).resolves.toEqual({ status: "sent", kind: "text", messageId: SENT_ID });
    expect(JSON.parse(String(calls[0]!.init.body)).message.parts).toEqual([
      { type: "selection", title: "Cities", options },
    ]);
    expect(JSON.parse(String(calls[1]!.init.body)).message.parts).toEqual([
      { type: "text", value: "Pick any." },
      { type: "selection", title: "Cities", options },
    ]);
  });

  it("sends the buttons alone when the whole turn is the choice", async () => {
    expect(sendInputSchema.safeParse({
      kind: "text",
      buttons: [{ label: "Yes" }, { label: "No" }],
    }).success).toBe(true);
    // Empty words are no words, the shape a model that fills every field sends.
    expect(sendInputSchema.safeParse({ kind: "text", text: "", buttons: [{ label: "Yes" }] }).data)
      .toEqual({ kind: "text", text: "", buttons: [{ label: "Yes" }] });
    expect(sendInputSchema.safeParse({ kind: "text", text: "  \n", buttons: [{ label: "Yes" }] }).success).toBe(true);
    // Words are still required when there is nothing else to carry the turn.
    expect(sendInputSchema.safeParse({ kind: "text" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "   " }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", buttons: [] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "voice_memo", text: "" }).success).toBe(false);

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
    await expect(executeRelaySend(dependencies(), {
      kind: "text",
      text: "",
      buttons: [{ label: "Yes" }, { label: "No" }],
    })).resolves.toEqual({ status: "sent", kind: "text", messageId: SENT_ID });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      message: {
        parts: [
          { type: "buttons", items: [{ label: "Yes" }, { label: "No" }] },
        ],
        idempotency_key: `relay-agent:${MESSAGE_ID}`,
      },
    });
  });

  it("sends nothing when a newer Message aborts composition", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    }));
    const controller = new AbortController();
    const sending = executeRelaySend(dependencies(
      [],
      (_text, _eventId, _startedAt, signal) =>
        abortableDelay(30_000, signal),
    ), {
      kind: "text",
      text: "this answer should be superseded",
    }, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("superseded"));
    await expect(sending).rejects.toThrow("superseded");
    expect(calls).toEqual([]);
  });

  it("terminally commits a started voice memo before a later turn abort", async () => {
    const activity = new ActivityServer();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const irreversible: boolean[] = [];
    const tasks: Promise<void>[] = [];
    let resolveVoice: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      calls.push({ url, init });
      const activityResponse = activity.respond(url, init);
      if (activityResponse) return activityResponse;
      if (url.endsWith("/typing")) return new Response(null, { status: 204 });
      if (url.endsWith("/v1/attachments")) {
        return Response.json({
          attachment_id: ATTACHMENT_ID,
          upload_url: "https://upload.example/voice",
          download_url: "https://api.example.test/attachment",
          http_method: "PUT",
          expires_at: "2026-09-01T12:00:00Z",
          required_headers: { "content-type": "audio/x-wav" },
        });
      }
      if (url === "https://upload.example/voice") {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/voicememo")) {
        return new Promise<Response>((resolve) => {
          resolveVoice = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const controller = new AbortController();
    const sending = executeRelaySend(dependencies(
      irreversible,
      async () => undefined,
      tasks,
    ), {
      kind: "voice_memo",
      text: "yo this is Relay",
      activity: "Saying hi",
      activity_emoji: "👋",
    }, controller.signal);
    await expect(sending).resolves.toEqual({
      status: "terminal_ambiguous",
      kind: "voice_memo",
      result: "send_started_outcome_not_confirmed",
    });

    expect(irreversible).toEqual([true]);
    expect(activity.activity).toMatchObject({ text: "Saying hi", emoji: "👋" });
    expect(activity.calls.some((call) => call.method === "DELETE")).toBe(false);
    controller.abort(new Error("newer turn"));
    expect(activity.activity).not.toBeNull();
    resolveVoice?.(Response.json({
      voice_memo: { id: SENT_ID },
    }));
    await Promise.all(tasks);
    expect(activity.activity).toBeNull();
    expect(irreversible).toEqual([true, false]);
    const allocation = calls.find(({ url }) =>
      url.endsWith("/v1/attachments")
    );
    expect(JSON.parse(String(allocation?.init.body))).toMatchObject({
      filename: `relay-${MESSAGE_ID}.wav`,
      content_type: "audio/x-wav",
      size_bytes: 48,
      duration_ms: 1,
    });
    const upload = calls.find(({ url }) =>
      url === "https://upload.example/voice"
    );
    const uploadBytes = new Uint8Array(upload?.init.body as ArrayBuffer);
    expect(new TextDecoder().decode(uploadBytes.slice(0, 4))).toBe("RIFF");
    const voice = calls.find(({ url }) => url.endsWith("/voicememo"));
    expect(JSON.parse(String(voice?.init.body))).toEqual({
      attachment_id: ATTACHMENT_ID,
    });
  });

  it("terminally returns ambiguous when Relay accepted then disconnected", async () => {
    const activity = new ActivityServer();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tasks: Promise<void>[] = [];
    const irreversible: boolean[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      calls.push({ url, init });
      const activityResponse = activity.respond(url, init);
      if (activityResponse) return activityResponse;
      if (url.endsWith("/typing")) return new Response(null, { status: 204 });
      if (url.endsWith("/v1/attachments")) {
        return Response.json({
          attachment_id: ATTACHMENT_ID,
          upload_url: "https://upload.example/voice",
          download_url: "https://api.example.test/attachment",
          http_method: "PUT",
          expires_at: "2026-09-01T12:00:00Z",
          required_headers: { "content-type": "audio/x-wav" },
        });
      }
      if (url === "https://upload.example/voice") {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/voicememo")) {
        throw new TypeError("accepted then lost relay-test-token");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await expect(executeRelaySend(dependencies(
      irreversible,
      async () => undefined,
      tasks,
    ), {
      kind: "voice_memo",
      text: "one attempt only",
      activity: "Recording",
    })).resolves.toEqual({
      status: "terminal_ambiguous",
      kind: "voice_memo",
      result: "send_started_outcome_not_confirmed",
    });
    await Promise.all(tasks);
    expect(activity.activity).toBeNull();
    expect(activity.calls.map((call) => call.method)).toEqual(["PUT", "DELETE"]);

    expect(calls.filter(({ url }) => url.endsWith("/voicememo"))).toHaveLength(1);
    expect(irreversible).toEqual([true, false]);
    const logs = warning.mock.calls.flat().join("\n");
    expect(logs).toContain('"outcome":"ambiguous"');
    expect(logs).toMatch(/"error_type":"[^"]+"/u);
    expect(logs).not.toContain("relay-test-token");
    expect(logs).not.toContain("accepted then lost");
  });

  it("does not retry or reopen the voice Action when its sole request times out", async () => {
    const activity = new ActivityServer();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const tasks: Promise<void>[] = [];
    const irreversible: boolean[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn((
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      calls.push({ url, init });
      const activityResponse = activity.respond(url, init);
      if (activityResponse) return Promise.resolve(activityResponse);
      if (url.endsWith("/typing")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/v1/attachments")) {
        return Promise.resolve(Response.json({
          attachment_id: ATTACHMENT_ID,
          upload_url: "https://upload.example/voice",
          download_url: "https://api.example.test/attachment",
          http_method: "PUT",
          expires_at: "2026-09-01T12:00:00Z",
          required_headers: { "content-type": "audio/x-wav" },
        }));
      }
      if (url === "https://upload.example/voice") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url.endsWith("/voicememo")) {
        return Promise.reject(new DOMException(
          "The operation timed out",
          "TimeoutError",
        ));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    await expect(executeRelaySend(dependencies(
      irreversible,
      async () => undefined,
      tasks,
    ), {
      kind: "voice_memo",
      text: "timeout once",
      activity: "Recording",
    })).resolves.toMatchObject({ status: "terminal_ambiguous" });
    expect(calls.filter(({ url }) => url.endsWith("/voicememo"))).toHaveLength(1);
    await Promise.all(tasks);
    expect(activity.activity).toBeNull();
    expect(activity.calls.map((call) => call.method)).toEqual(["PUT", "DELETE"]);
    expect(calls.filter(({ url }) => url.endsWith("/voicememo"))).toHaveLength(1);
    expect(irreversible).toEqual([true, false]);
  });
});

describe("Relay react Action", () => {
  it("rejects a superseded turn before dispatching a reaction", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const deps = dependencies();
    deps.assertCurrentTurn = () => {
      throw new DOMException("Relay turn superseded", "AbortError");
    };

    await expect(executeRelayReaction(deps, {
      type: "love",
    })).rejects.toThrow("Relay turn superseded");
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe("Relay send Action: link", () => {
  it("sends a link as its own Message, after the words when there are any", async () => {
    expect(sendInputSchema.safeParse({ kind: "link", url: "https://example.com/listing/42" }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "link", url: "https://example.com/x", text: "Found this:" }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "link" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "link", url: "ftp://example.com" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "link", url: "https://example.com", buttons: [{ label: "a" }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "x", url: "https://example.com" }).success).toBe(false);
    const schema = toJSONSchema(sendInputSchema, { io: "input" }) as { oneOf?: unknown; properties?: Record<string, { description?: string }> };
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties?.url?.description).toContain("drawn as a card");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
    await expect(executeRelaySend(dependencies(), {
      kind: "link",
      url: "https://example.com/listing/42",
      text: "Found this:",
    })).resolves.toEqual({ status: "sent", kind: "link", messageId: SENT_ID });
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { message: { parts: [{ type: "text", value: "Found this:" }], idempotency_key: `relay-agent:${MESSAGE_ID}` } },
      { message: { parts: [{ type: "link", value: "https://example.com/listing/42" }], idempotency_key: `relay-agent:${MESSAGE_ID}:link` } },
    ]);

    calls.length = 0;
    await executeRelaySend(dependencies(), { kind: "link", url: "https://example.com/listing/42" });
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { message: { parts: [{ type: "link", value: "https://example.com/listing/42" }], idempotency_key: `relay-agent:${MESSAGE_ID}` } },
    ]);
  });
});

describe("Relay send Action: payment", () => {
  const CHECKOUT_URL = "https://pay.relayapp.im/prq_test_token";
  const PAYMENT_REQUEST_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";

  function paymentRequest(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_REQUEST_ID,
      object: "payment_request",
      status: "requested",
      mode: "payment",
      amount: 450,
      currency: "usd",
      description: "Coffee",
      category: "physical_goods",
      checkout_url: CHECKOUT_URL,
      expires_at: "2026-09-24T12:00:00.000Z",
      metadata: {},
      stripe: { payment_intent_id: "pi_test" },
      created_at: "2026-09-23T13:00:00.000Z",
      updated_at: "2026-09-23T13:00:00.000Z",
      ...overrides,
    };
  }

  it("requires the fields of each mode and refuses a checkout link from the model", () => {
    const coffee = { kind: "payment", description: "Coffee", category: "physical_goods", amount: 450, currency: "usd" };
    expect(sendInputSchema.safeParse(coffee).success).toBe(true);
    expect(sendInputSchema.safeParse({ ...coffee, mode: "payment", image_url: "https://example.com/coffee.png" }).success).toBe(true);
    expect(sendInputSchema.safeParse({
      kind: "payment", description: "Pro plan", category: "digital_goods", mode: "subscription", price_id: "price_123",
    }).success).toBe(true);
    for (const field of ["description", "category", "amount", "currency"] as const) {
      const { [field]: _omitted, ...rest } = coffee;
      expect(sendInputSchema.safeParse(rest).success, field).toBe(false);
    }
    // Subscription mode takes price_id and neither amount nor currency.
    expect(sendInputSchema.safeParse({ kind: "payment", description: "Pro plan", category: "digital_goods", mode: "subscription" }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "payment", description: "Pro plan", category: "digital_goods", mode: "subscription", price_id: "price_123", amount: 999,
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, price_id: "price_123" }).success).toBe(false);
    // The contract's limits: description 1 to 32, integer minor units, a
    // 3-letter currency, the three categories, an https image.
    expect(sendInputSchema.safeParse({ ...coffee, description: "x".repeat(33) }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, amount: 4.5 }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, amount: 0 }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, currency: "us" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, category: "service" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, image_url: "http://example.com/coffee.png" }).success).toBe(false);
    // The checkout link is never a model field, and a payment travels alone.
    expect(sendInputSchema.safeParse({ ...coffee, url: "https://model-invented.example/pay" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, text: "Here you go" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...coffee, buttons: [{ label: "Pay" }] }).success).toBe(false);
    // Payment fields belong to kind payment only.
    expect(sendInputSchema.safeParse({ kind: "text", text: "hi", amount: 450 }).success).toBe(false);
  });

  it("creates the payment request, then sends the returned checkout_url alone", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/payment_requests")) {
        return Response.json(paymentRequest(), { status: 201 });
      }
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
    await expect(executeRelaySend(dependencies(), {
      kind: "payment",
      description: "Coffee",
      category: "physical_goods",
      amount: 450,
      currency: "USD",
      image_url: "https://example.com/coffee.png",
    })).resolves.toEqual({
      status: "sent",
      kind: "payment",
      messageId: SENT_ID,
      payment_request_id: paymentRequest().id,
    });

    expect(calls).toHaveLength(2);
    const [create, send] = calls;
    expect(create!.url).toBe("https://api.example.test/v1/payment_requests");
    expect(create!.init.method).toBe("POST");
    const headers = new Headers(create!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer relay-test-token");
    expect(headers.get("idempotency-key")).toBe(`relay-agent:${MESSAGE_ID}:payment_request`);
    expect(JSON.parse(String(create!.init.body))).toEqual({
      description: "Coffee",
      category: "physical_goods",
      amount: 450,
      currency: "usd",
      image_url: "https://example.com/coffee.png",
      // Routes the request's payment.* events back to this Chat.
      metadata: { chat_id: CHAT_ID },
    });
    expect(new URL(send!.url).pathname).toBe(`/v1/chats/${CHAT_ID}/messages`);
    expect(JSON.parse(String(send!.init.body))).toEqual({
      message: {
        parts: [{ type: "payment", checkout_url: CHECKOUT_URL }],
        idempotency_key: `relay-agent:${MESSAGE_ID}`,
      },
    });
  });

  it("creates a subscription from price_id with no amount or currency", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/payment_requests")) {
        return Response.json(paymentRequest({ mode: "subscription", price_id: "price_123" }), { status: 201 });
      }
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
    await executeRelaySend(dependencies(), {
      kind: "payment",
      description: "Pro plan",
      category: "digital_goods",
      mode: "subscription",
      price_id: "price_123",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      description: "Pro plan",
      category: "digital_goods",
      mode: "subscription",
      price_id: "price_123",
      metadata: { chat_id: CHAT_ID },
    });
    expect(JSON.parse(String(calls[1]!.init.body)).message.parts).toEqual([
      { type: "payment", checkout_url: CHECKOUT_URL },
    ]);
  });

  function refusingCreate(status: number, message: string, code: number) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({
        error: { status, code, message },
        success: false,
        trace_id: "trace",
      }, { status });
    }));
    return calls;
  }

  it("hands a 403 from create to the model as RelayPaymentRefused with Relay's reason, sends nothing, and does not retry", async () => {
    const message = "Connect Stripe in Relay Console before creating payment requests.";
    const calls = refusingCreate(403, message, 2003);
    await expect(executeRelaySend(dependencies(), {
      kind: "payment",
      description: "Coffee",
      category: "physical_goods",
      amount: 450,
      currency: "usd",
    })).rejects.toMatchObject({ name: "RelayPaymentRefused", message: expect.stringContaining(message) });
    expect(calls).toEqual(["https://api.example.test/v1/payment_requests"]);
  });

  it("throws any other create failure", async () => {
    refusingCreate(400, "Amount must be at least $0.50 usd", 1001);
    await expect(executeRelaySend(dependencies(), {
      kind: "payment",
      description: "Coffee",
      category: "physical_goods",
      amount: 10,
      currency: "usd",
    })).rejects.toMatchObject({ status: 400, message: "Amount must be at least $0.50 usd" });
  });
});

describe("Relay send Action: rich_card and carousel", () => {
  const CARD = {
    title: "Oat latte, large",
    description: "Ready in 5 minutes at Philz, Forest Ave.",
    image_url: "https://example.com/latte.jpg",
    suggestions: [
      { label: "Order for $5.40", id: "order-1042" },
      { label: "See the menu", url: "https://philzcoffee.com/menu" },
    ],
  };
  const CARD_PART = {
    media: { type: "image", url: "https://example.com/latte.jpg" },
    title: "Oat latte, large",
    description: "Ready in 5 minutes at Philz, Forest Ave.",
    suggestions: [
      { type: "reply", label: "Order for $5.40", id: "order-1042" },
      { type: "open_url", label: "See the menu", url: "https://philzcoffee.com/menu" },
    ],
  };

  function relayMessages(response: () => Response = () =>
    Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } }, { status: 202 })
  ) {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.endsWith(`/v1/chats/${CHAT_ID}/messages`)) throw new Error(`Unexpected fetch: ${url}`);
      bodies.push(JSON.parse(String(init.body)));
      return response();
    }));
    return bodies;
  }

  it("takes card fields only with the card kinds", () => {
    expect(sendInputSchema.safeParse({ kind: "rich_card", cards: [CARD] }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "rich_card" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "rich_card", cards: [CARD], card_width: "small" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "carousel", cards: [CARD, CARD], card_width: "small" }).success)
      .toBe(false); // the two cards repeat reply id order-1042
    expect(sendInputSchema.safeParse({ kind: "text", text: "hi", cards: [CARD] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "rich_card", cards: [CARD], buttons: [{ label: "x" }] }).success)
      .toBe(false);
  });

  it("refuses a rich_card with more than one card and a carousel with fewer than two", () => {
    expect(sendInputSchema.safeParse({ kind: "rich_card", cards: [{ title: "a" }, { title: "b" }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "carousel", cards: [{ title: "a" }] }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "carousel", cards: [{ title: "a" }, { title: "b" }] }).success).toBe(true);
  });

  it("refuses an empty card, a suggestion with both or neither of id and url, and a repeated reply id", () => {
    expect(sendInputSchema.safeParse({ kind: "rich_card", cards: [{}] }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "rich_card", cards: [{ title: "a", suggestions: [{ label: "Go" }] }],
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "rich_card", cards: [{ title: "a", suggestions: [{ label: "Go", id: "go", url: "https://a.com" }] }],
    }).success).toBe(false);
    expect(sendInputSchema.safeParse({
      kind: "carousel",
      cards: [{ title: "a", suggestions: [{ label: "Pick", id: "x" }] }, { title: "b", suggestions: [{ label: "Pick", id: "x" }] }],
    }).success).toBe(false);
  });

  it("builds Relay's exact rich_card part: media, title, description, reply and open_url suggestions", async () => {
    const bodies = relayMessages();
    await expect(executeRelaySend(dependencies(), { kind: "rich_card", cards: [CARD] }))
      .resolves.toEqual({ status: "sent", kind: "rich_card", messageId: SENT_ID });
    expect(bodies).toEqual([{
      message: {
        idempotency_key: `relay-agent:${MESSAGE_ID}`,
        parts: [{ type: "rich_card", ...CARD_PART }],
      },
    }]);
  });

  it("puts the words before the card when the model gives text", async () => {
    const bodies = relayMessages();
    await executeRelaySend(dependencies(), { kind: "rich_card", text: "Here is your order.", cards: [{ title: "Latte" }] });
    expect((bodies[0] as { message: { parts: unknown[] } }).message.parts).toEqual([
      { type: "text", value: "Here is your order." },
      { type: "rich_card", title: "Latte" },
    ]);
  });

  it("builds a carousel with its card width, every card in order", async () => {
    const bodies = relayMessages();
    await expect(executeRelaySend(dependencies(), {
      kind: "carousel",
      card_width: "small",
      cards: [CARD, { title: "Cold brew", suggestions: [{ label: "Order", id: "order-1043" }] }],
    })).resolves.toEqual({ status: "sent", kind: "carousel", messageId: SENT_ID });
    expect((bodies[0] as { message: { parts: unknown[] } }).message.parts).toEqual([{
      type: "carousel",
      card_width: "small",
      cards: [CARD_PART, { title: "Cold brew", suggestions: [{ type: "reply", label: "Order", id: "order-1043" }] }],
    }]);
  });

  it("hands Relay's refusal back as RelayCardRefused, with Relay's reason, so the model can fix it", async () => {
    relayMessages(() => Response.json({
      error: { status: 400, code: 1005, message: "A suggestion label is at most 25 characters." },
      success: false,
      trace_id: "0a76ee4c4a1e4807a12e24965501bf64",
    }, { status: 400 }));
    const sending = executeRelaySend(dependencies(), { kind: "rich_card", cards: [{ title: "Latte" }] });
    await expect(sending).rejects.toBeInstanceOf(RelayCardRefused);
    await expect(sending).rejects.toThrow(/at most 25 characters/u);
  });

  it("takes another step after a refused card or payment, and ends the turn once a card is sent", () => {
    const settled = (output: unknown) => relayTurnSettled({
      steps: [{
        toolCalls: [{ toolCallId: "call-0", toolName: "send" }],
        toolResults: [{ toolCallId: "call-0", toolName: "send", output }],
      } as unknown as StepResult<ToolSet>],
    });
    expect(settled({ error: { name: "RelayCardRefused", message: "fix it" } })).toBe(false);
    expect(settled({ error: { name: "RelayPaymentRefused", message: "no Stripe" } })).toBe(false);
    expect(settled({ status: "sent", kind: "rich_card" })).toBe(true);
    expect(settled({ error: { name: "RelayAPIError", message: "down" } })).toBe(true);
  });
});

describe("the composing pause", () => {
  function stubMessages(posts: string[]): void {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      posts.push(new URL(String(input)).pathname);
      return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
    }));
  }

  function typingSince(composingSince: number): RelayActionDependencies {
    return {
      ...dependencies(),
      compose: undefined,
      turn: () => ({ chatId: CHAT_ID, eventId: MESSAGE_ID, composingSince }),
    };
  }

  const words = "ok so here is the plan for tonight, three things and then you sleep";

  it("counts from the turn's typing indicator, so a reply whose model took longer than the pause goes at once", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    stubMessages(posts);
    // The dots went up 7 s ago, longer than the longest pause (6 s).
    const sending = executeRelaySend(typingSince(Date.now() - 7_000), { kind: "text", text: words });
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toEqual([`/v1/chats/${CHAT_ID}/messages`]);
    await expect(sending).resolves.toMatchObject({ status: "sent" });
  });

  it("still pauses for the rest of it when the model was quicker than a person types", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    stubMessages(posts);
    const sending = executeRelaySend(typingSince(Date.now() - 1_000), { kind: "text", text: words });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(posts).toEqual([`/v1/chats/${CHAT_ID}/messages`]);
    await expect(sending).resolves.toMatchObject({ status: "sent" });
  });
});
