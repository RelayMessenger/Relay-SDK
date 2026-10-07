import { afterEach, describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod";

vi.mock("@cloudflare/think", () => ({ action: (config: unknown) => ({ config }) }));

import { executeRelaySend, type RelayActionDependencies, sendInputSchema, type SendInput } from "../src/actions";
import { RelayGenerationActivities } from "../src/activity";

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const SENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";

function dependencies(composed: string[] = []): RelayActionDependencies {
  return {
    env: { RELAY_AGENT_TOKEN: "relay-test-token", RELAY_API_ORIGIN: "https://api.example.test" },
    activities: new RelayGenerationActivities(),
    turn: () => ({ chatId: CHAT_ID, eventId: MESSAGE_ID }),
    signal: (signal) => signal,
    assertCurrentTurn: () => undefined,
    setIrreversibleSend: () => undefined,
    waitUntil: () => undefined,
    runChosenAction: (_name, operation) => operation(),
    compose: async (text) => { composed.push(text); },
  };
}

function recordSends(): unknown[] {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    expect(String(input)).toBe(`https://api.example.test/v1/chats/${CHAT_ID}/messages`);
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ chat_id: CHAT_ID, message: { id: SENT_ID } });
  }));
  return bodies;
}

const FORM = {
  title: "Booking",
  pages: [{
    id: "details",
    title: "Details",
    fields: [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "size", type: "select", label: "Party size", options: [{ value: "two", label: "Two" }, { value: "four", label: "Four" }] },
      { id: "day", type: "date", label: "Day", min_date: "2026-10-08" },
    ],
  }],
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Relay send Action: form", () => {
  it("takes a form only with kind form, checked by the SDK's own form validator", () => {
    expect(sendInputSchema.safeParse({ kind: "form", form: FORM }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "form", form: FORM, text: "A few details:" }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "form" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "text", text: "hi", form: FORM }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "form", form: FORM, buttons: [{ label: "a" }] }).success).toBe(false);
    // Only the SDK's validator knows these rules: a select field needs options,
    // and field ids are unique across every page.
    const noOptions = { ...FORM, pages: [{ ...FORM.pages[0], fields: [{ id: "size", type: "select", label: "Size" }] }] };
    const refused = sendInputSchema.safeParse({ kind: "form", form: noOptions });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path)).toContainEqual(["form"]);
    const repeated = {
      ...FORM,
      pages: [FORM.pages[0], { id: "more", title: "More", fields: [{ id: "name", type: "text", label: "Again" }] }],
    };
    expect(sendInputSchema.safeParse({ kind: "form", form: repeated }).success).toBe(false);
    const schema = toJSONSchema(sendInputSchema) as { oneOf?: unknown; anyOf?: unknown; properties?: Record<string, unknown> };
    expect(schema.oneOf).toBeUndefined();
    expect(JSON.stringify(schema.properties?.form)).not.toMatch(/"(oneOf|anyOf)"/u);
  });

  it("sends the words then the form part in one Message", async () => {
    const bodies = recordSends();
    const composed: string[] = [];
    const input = sendInputSchema.parse({ kind: "form", form: FORM, text: "A few details:" }) as SendInput;
    await expect(executeRelaySend(dependencies(composed), input))
      .resolves.toEqual({ status: "sent", kind: "form", messageId: SENT_ID });
    expect(composed).toEqual(["A few details:"]);
    expect(bodies).toEqual([{
      message: {
        parts: [{ type: "text", value: "A few details:" }, { type: "form", ...FORM }],
        idempotency_key: `relay-agent:${MESSAGE_ID}`,
      },
    }]);
  });
});

describe("Relay send Action: rating_request", () => {
  it("is the whole Message, with no other field", async () => {
    expect(sendInputSchema.safeParse({ kind: "rating_request" }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "rating_request", text: "rate me" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "rating_request", url: "https://example.com" }).success).toBe(false);
    const bodies = recordSends();
    const composed: string[] = [];
    await expect(executeRelaySend(dependencies(composed), { kind: "rating_request" }))
      .resolves.toEqual({ status: "sent", kind: "rating_request", messageId: SENT_ID });
    expect(composed).toEqual([]);
    expect(bodies).toEqual([{
      message: { parts: [{ type: "rating_request" }], idempotency_key: `relay-agent:${MESSAGE_ID}` },
    }]);
  });
});

describe("Relay send Action: media", () => {
  it("takes one https url, and words only beside it", () => {
    expect(sendInputSchema.safeParse({ kind: "media", url: "https://example.com/menu.pdf" }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "media", url: "https://example.com/a.jpg", text: "Tonight:" }).success).toBe(true);
    expect(sendInputSchema.safeParse({ kind: "media" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "media", url: "http://example.com/a.jpg" }).success).toBe(false);
    expect(sendInputSchema.safeParse({ kind: "media", url: "https://example.com/a.jpg", caption: "x" }).success).toBe(false);
  });

  it("sends the file by url, with Relay fetching it, after the words in the same Message", async () => {
    const bodies = recordSends();
    const composed: string[] = [];
    await expect(executeRelaySend(dependencies(composed), {
      kind: "media", url: "https://example.com/a.jpg", text: "Tonight:",
    })).resolves.toEqual({ status: "sent", kind: "media", messageId: SENT_ID });
    await executeRelaySend(dependencies(composed), { kind: "media", url: "https://example.com/menu.pdf" });
    expect(composed).toEqual(["Tonight:"]);
    expect(bodies).toEqual([
      {
        message: {
          parts: [{ type: "text", value: "Tonight:" }, { type: "media", url: "https://example.com/a.jpg" }],
          idempotency_key: `relay-agent:${MESSAGE_ID}`,
        },
      },
      {
        message: {
          parts: [{ type: "media", url: "https://example.com/menu.pdf" }],
          idempotency_key: `relay-agent:${MESSAGE_ID}`,
        },
      },
    ]);
  });
});
