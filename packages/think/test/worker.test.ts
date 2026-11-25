import { signWebhookHeaders, type Message, type WebhookSubscription } from "@relaymessenger/sdk";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_CONTEXT_MESSAGES,
  MediaGenerationError,
  RELAY_MESSAGE_ADMISSION_HEADER,
  RELAY_MESSAGE_SERIAL_HEADER,
  RELAY_SUBSCRIBED_EVENTS,
  RELAY_WEBHOOK_PATH,
  authenticateRelayWebhook,
  callTranscriptHistory,
  chatContext,
  extractPartMentions,
  formatRelayMessageIdentity,
  generateImage,
  generateVoiceMemo,
  isOwnerMentioned,
  mentionedHandles,
  prepareTurnMessages,
  prewarmsVoice,
  reconcileWebhookSubscription,
  urlContextUse,
  wavFromPCM,
  webSearchEnabled,
  webSearchUse,
  withoutSearchMarkers,
} from "../src/worker.js";
import { createRelayClient } from "../src/typing.js";

const SECRET = `whsec_${Buffer.from("relay-think-worker-test-secret-01").toString("base64")}`;
const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const AGENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const USER_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";

function signedWebhookRequest(envelope: unknown): Request {
  const body = JSON.stringify(envelope);
  const headers = signWebhookHeaders(SECRET, { id: EVENT_ID, body });
  return new Request(`https://agent.example.test${RELAY_WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function groupEnvelope(parts: unknown[], senderKind: "user" | "agent" = "user") {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_type: "message.received",
    event_id: EVENT_ID,
    agent_id: AGENT_ID,
    trace_id: "trace-1",
    created_at: "2026-10-08T12:00:00.000Z",
    data: {
      id: MESSAGE_ID,
      direction: "inbound",
      sent_at: "2026-10-08T12:00:00.000Z",
      chat: {
        id: CHAT_ID,
        is_group: true,
        owner_handle: { id: AGENT_ID, handle: "jobs", display_name: "Steve Jobs" },
      },
      sender_handle: {
        id: USER_ID,
        handle: senderKind === "user" ? "alex" : "graham",
        kind: senderKind,
        is_me: false,
      },
      parts,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("@relaymessenger/think/worker webhook helpers", () => {
  it("extracts mentions from both part.mentions arrays and legacy part.mention", () => {
    const parts = [
      { type: "text", value: "@jobs @graham thoughts?", mentions: [{ handle: "jobs", is_me: true }, { handle: "graham" }] },
      { type: "text", value: "also @kay", mention: "kay" },
      { type: "media", id: "m1" },
    ];
    expect([...mentionedHandles(parts, "jobs")].sort()).toEqual(["graham", "jobs", "kay"]);
    expect(isOwnerMentioned(parts, "jobs")).toBe(true);
    expect(
      isOwnerMentioned(
        [{ type: "text", value: "@jobs @graham thoughts?", mentions: [{ handle: "jobs", is_me: false }, { handle: "graham" }] }],
        "musk",
      ),
    ).toBe(false);
    expect(extractPartMentions({ type: "text", mentions: [{ is_me: true }] }, "jobs")).toEqual(["jobs"]);
    expect(
      extractPartMentions({ type: "text", mentions: [{ handle: "Iris", is_me: true }] }, "iris"),
    ).toEqual(["Iris", "iris"]);
    expect(
      isOwnerMentioned([{ type: "text", mentions: [{ handle: "Iris", is_me: true }] }], "iris"),
    ).toBe(true);
    expect(
      isOwnerMentioned([{ type: "text", mentions: [{ handle: "Iris", is_me: true }] }], undefined),
    ).toBe(true);
  });

  it("authenticates signed webhooks and admits multi-mention group messages", async () => {
    const request = signedWebhookRequest(
      groupEnvelope([{
        type: "text",
        value: "@graham @jobs what do you think?",
        mentions: [{ handle: "graham", is_me: false }, { handle: "jobs", is_me: true }],
      }]),
    );
    const result = await authenticateRelayWebhook(request, SECRET);
    expect(result instanceof Response).toBe(false);
    if (result instanceof Response) return;

    expect(result.instanceName).toBe(`chat:${CHAT_ID}`);
    expect(result.event).toEqual({ id: EVENT_ID, type: "message.received" });
    expect(result.admission).toEqual({
      messageId: MESSAGE_ID,
      sentAt: Date.parse("2026-10-08T12:00:00.000Z"),
    });
    expect(result.delivery?.admission).toEqual(result.admission);
    const forwarded = result.request();
    expect(forwarded.headers.get(RELAY_MESSAGE_ADMISSION_HEADER)).toBe(
      formatRelayMessageIdentity(result.admission!),
    );
    expect(forwarded.headers.get(RELAY_MESSAGE_SERIAL_HEADER)).toBe(
      formatRelayMessageIdentity(result.serial!),
    );
  });

  it("marks agent-sent messages with fromAgent and skips admission for unmentioned group messages", async () => {
    const request = signedWebhookRequest(
      groupEnvelope([{ type: "text", value: "plain group chatter" }], "agent"),
    );
    const result = await authenticateRelayWebhook(request, SECRET);
    expect(result instanceof Response).toBe(false);
    if (result instanceof Response) return;

    expect(result.admission).toBeUndefined();
    expect(result.serial).toEqual({
      messageId: MESSAGE_ID,
      sentAt: Date.parse("2026-10-08T12:00:00.000Z"),
      fromAgent: true,
    });
    expect(formatRelayMessageIdentity(result.serial!)).toMatch(/:agent$/u);

    const admittedAll = await authenticateRelayWebhook(
      signedWebhookRequest(groupEnvelope([{ type: "text", value: "plain group chatter" }], "agent")),
      SECRET,
      { everyGroupMessage: true },
    );
    expect(admittedAll instanceof Response).toBe(false);
    if (admittedAll instanceof Response) return;
    expect(admittedAll.admission).toEqual(result.serial);
  });

  it("rejects invalid webhook signatures with 401", async () => {
    const req = new Request(`https://agent.example.test${RELAY_WEBHOOK_PATH}`, {
      method: "POST",
      body: JSON.stringify({ event_id: EVENT_ID }),
    });
    const res = await authenticateRelayWebhook(req, SECRET);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });
});

describe("@relaymessenger/think/worker subscription reconciliation", () => {
  const targetUrl = `https://agent.example.test${RELAY_WEBHOOK_PATH}`;
  const baseSub: WebhookSubscription = {
    id: "sub-1",
    target_url: targetUrl,
    subscribed_events: [...RELAY_SUBSCRIBED_EVENTS],
    is_active: true,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };

  it("returns unchanged when the subscription already matches", async () => {
    const update = vi.fn();
    const result = await reconcileWebhookSubscription({
      webhookSubscriptions: {
        list: async () => ({ subscriptions: [baseSub] }),
        update,
        retrieve: async () => baseSub,
        create: vi.fn(),
        delete: vi.fn(),
      },
    } as never, { targetUrl });
    expect(result.status).toBe("unchanged");
    expect(update).not.toHaveBeenCalled();
  });

  it("updates the existing subscription in place and reads back to verify", async () => {
    const stale: WebhookSubscription = { ...baseSub, subscribed_events: ["message.received"] };
    let current = stale;
    const update = vi.fn(async (_id, body: { subscribed_events: WebhookSubscription["subscribed_events"] }) => {
      current = { ...current, subscribed_events: body.subscribed_events, updated_at: "2026-10-08T12:00:00.000Z" };
      return current;
    });
    const result = await reconcileWebhookSubscription({
      webhookSubscriptions: {
        list: async () => ({ subscriptions: [stale] }),
        update,
        retrieve: async () => current,
        create: vi.fn(),
        delete: vi.fn(),
      },
    } as never, { targetUrl });
    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.before).toEqual(["message.received"]);
      expect(result.subscription.subscribed_events).toEqual([...RELAY_SUBSCRIBED_EVENTS]);
    }
    expect(update).toHaveBeenCalledOnce();
  });

  it("throws when the subscription is missing or inactive", async () => {
    await expect(reconcileWebhookSubscription({
      webhookSubscriptions: {
        list: async () => ({ subscriptions: [] }),
        update: vi.fn(),
        retrieve: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
    } as never, { targetUrl })).rejects.toThrow(/Expected one webhook subscription/);

    await expect(reconcileWebhookSubscription({
      webhookSubscriptions: {
        list: async () => ({ subscriptions: [{ ...baseSub, is_active: false }] }),
        update: vi.fn(),
        retrieve: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
    } as never, { targetUrl })).rejects.toThrow(/inactive/);
  });
});

describe("@relaymessenger/think/worker prepareTurnMessages (FTS query pollution fix)", () => {
  it("passes unmodified user text to memory.turn while attaching inbound media, docs, history images, and memory", async () => {
    const history: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "Old photo" }],
        metadata: { turnMetadata: { message: { id: "m1", attachments: [{ id: "img-old", filename: "old.png", mime_type: "image/png" }] } } },
      },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "Looks great" }] },
      { id: "m3", role: "user", parts: [{ type: "text", text: "What did we decide about pricing?" }] },
    ];
    const baseMessages = await convertToModelMessages(history);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v1/attachments/img-old")) {
        return Response.json({
          id: "img-old",
          filename: "old.png",
          content_type: "image/png",
          status: "complete",
          size_bytes: 4,
          download_url: "https://files.example.test/old.png",
        });
      }
      if (url.hostname === "files.example.test") {
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const receivedByMemory: ModelMessage[][] = [];
    const memory = {
      turn: vi.fn(async (messages: ModelMessage[]) => {
        receivedByMemory.push(messages);
        const memoryMsg: ModelMessage = {
          role: "user",
          content: "<person_memory>\n## Group\nPricing was set to $20.\n</person_memory>",
        };
        return {
          messages: [...messages.slice(0, -1), memoryMsg, messages.at(-1)!],
          tools: { search_person_memory: {} as never },
        };
      }),
    };

    const prepared = await prepareTurnMessages({
      messages: baseMessages,
      history,
      relay: createRelayClient({ RELAY_AGENT_TOKEN: "tok", RELAY_API_ORIGIN: "https://api.example.test" }),
      media: {
        parts: [{ type: "file", mediaType: "image/jpeg", data: Uint8Array.of(9, 8) }],
        unreadable: ["- huge.zip (99999999 bytes): too large to view"],
        documents: [{ name: "contract.pdf", markdown: "HUGE CONVERTED PDF BODY THAT MUST NEVER POLLUTE FTS" }],
      },
      memory,
    });

    // 1. memory.turn received ONLY the unmodified messages (no PDF markdown, no unreadable notice, no FilePart)
    expect(memory.turn).toHaveBeenCalledOnce();
    const memoryInputText = JSON.stringify(receivedByMemory[0]);
    expect(memoryInputText).toContain("What did we decide about pricing?");
    expect(memoryInputText).not.toContain("HUGE CONVERTED PDF BODY");
    expect(memoryInputText).not.toContain("Attachments I cannot open");

    // 2. Final messages contain history image on msg 0, memory message before newest, and media+doc on newest!
    expect(prepared.messages).toHaveLength(4);
    expect(prepared.messages[0]!.content).toEqual([
      { type: "text", text: "Old photo" },
      { type: "file", filename: "old.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(prepared.messages[2]).toEqual({
      role: "user",
      content: "<person_memory>\n## Group\nPricing was set to $20.\n</person_memory>",
    });
    const newestContent = prepared.messages[3]!.content as Array<{ type: string; text?: string }>;
    expect(newestContent.some((p) => p.type === "text" && p.text?.includes("HUGE CONVERTED PDF BODY"))).toBe(true);
    expect(newestContent.some((p) => p.type === "text" && p.text?.includes("Attachments I cannot open"))).toBe(true);
    expect(newestContent.some((p) => p.type === "file")).toBe(true);
    expect(prepared.tools).toHaveProperty("search_person_memory");
  });
});

describe("@relaymessenger/think/worker voice, media, and web-search helpers", () => {
  it("formats voice chat context, prewarm predicate, and transcript history", () => {
    expect(CHAT_CONTEXT_MESSAGES).toBe(20);
    expect(prewarmsVoice("message.received", JSON.stringify({
      data: { direction: "inbound", sender_handle: { kind: "user", is_me: false } },
    }))).toBe(true);
    expect(prewarmsVoice("message.received", JSON.stringify({
      data: { direction: "inbound", sender_handle: { kind: "agent", is_me: false } },
    }))).toBe(false);

    const messages: Message[] = [
      {
        id: "m2", chat_id: CHAT_ID, is_from_me: true, is_system_message: false,
        delivery_status: "sent", created_at: "2026-10-08T12:01:00Z", updated_at: "2026-10-08T12:01:00Z",
        parts: [{ type: "text", value: "Sure thing", reactions: null }],
      },
      {
        id: "m1", chat_id: CHAT_ID, is_from_me: false, is_system_message: false,
        delivery_status: "delivered", created_at: "2026-10-08T12:00:00Z", updated_at: "2026-10-08T12:00:00Z",
        parts: [{ type: "text", value: "Check this", reactions: null }, {
          type: "media", id: "a1", url: "https://x.test/a.png", filename: "a.png", mime_type: "image/png", size_bytes: 1, reactions: null,
        }],
      },
    ];
    expect(chatContext(messages)).toBe("them: Check this [attachment]\nyou: Sure thing");

    const rows = callTranscriptHistory(
      { id: "call-1", chat_id: CHAT_ID, status: "completed", answered_at: "2026-10-08T12:00:00Z", ended_at: "2026-10-08T12:02:00Z" } as never,
      [
        { role: "user", text: "Hey there", at: "2026-10-08T12:00:10Z" },
        { role: "assistant", text: "Hi!", at: "2026-10-08T12:00:12Z" },
        { role: "user", text: "One more thing", at: "2026-10-08T12:01:50Z" },
      ],
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.id).toBe("relay-call-transcript:call-1:0");
    expect((rows[0]!.parts[0] as { text: string }).text).toContain("Relay call data");
    expect((rows[2]!.parts[0] as { text: string }).text).toContain("The call ended before you answered this.");
  });

  it("builds valid WAV headers from PCM and generates image/voice media through AI Gateway", async () => {
    const wav = wavFromPCM(new Uint8Array([1, 2, 3, 4]), 24_000);
    expect(wav.byteLength).toBe(48);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");

    const env = {
      CLOUDFLARE_ACCOUNT_ID: "acct",
      AI_GATEWAY_ID: "gw",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "secret",
      VERTEX_PROJECT_ID: "proj",
      VERTEX_LOCATION: "us-central1",
      VERTEX_IMAGE_MODEL: "gemini-image",
      VERTEX_TTS_MODEL: "gemini-tts",
      VERTEX_TTS_VOICE: "Puck",
    };

    vi.stubGlobal("fetch", async () => Response.json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: btoa("PNG") } }] } }],
    }));
    const img = await generateImage(env, "draw a cat");
    expect(img.contentType).toBe("image/png");
    expect(new TextDecoder().decode(img.bytes)).toBe("PNG");

    vi.stubGlobal("fetch", async () => Response.json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: btoa("1234") } }] } }],
    }));
    const voice = await generateVoiceMemo(env, "hello", "warm");
    expect(voice.contentType).toBe("audio/x-wav");
    expect(voice.durationMs).toBeGreaterThanOrEqual(1);

    await expect(generateImage({ ...env, CLOUDFLARE_AI_GATEWAY_TOKEN: "" }, "x")).rejects.toBeInstanceOf(MediaGenerationError);
  });

  it("extracts web search and URL context metadata and strips citation markers", () => {
    expect(webSearchEnabled({ RELAY_WEB_SEARCH: "true" })).toBe(true);
    expect(webSearchEnabled({})).toBe(false);
    expect(withoutSearchMarkers("Price is $10 [1.2.3] today.")).toBe("Price is $10 today.");
    expect(webSearchUse({
      googleVertex: {
        groundingMetadata: {
          webSearchQueries: ["relay docs"],
          groundingChunks: [{ web: { title: "Docs", uri: "https://docs.relayapp.im" } }],
        },
      },
    })).toEqual({
      queries: ["relay docs"],
      sources: [{ title: "Docs", uri: "https://docs.relayapp.im" }],
    });
    expect(urlContextUse({
      googleVertex: {
        urlContextMetadata: {
          urlMetadata: [{ retrievedUrl: "https://relayapp.im", urlRetrievalStatus: "SUCCESS" }],
        },
      },
    })).toEqual({
      urls: [{ url: "https://relayapp.im", status: "SUCCESS" }],
    });
  });
});
