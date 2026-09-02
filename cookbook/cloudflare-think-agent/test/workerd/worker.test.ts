import { SELF } from "cloudflare:test";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createRelayAdapterFor,
  createRelayMessenger,
  type RelayChatAgent,
} from "../../src/agent";
import type { Bindings } from "../../src/env";
import { starterModel } from "../../src/model";
import { sendRelayReply } from "../../src/reply";
import { TEST_REPLY_TEXT } from "./harness";

const WEBHOOK_SECRET = "test-secret";
const EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const AGENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";
const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";
const USER_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec15";
const REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec16";
const DIRECT_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec20";
const DIRECT_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec21";
const DIRECT_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec22";
const DIRECT_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec23";
const GROUP_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec30";
const GROUP_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec31";
const GROUP_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec32";
const GROUP_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec33";
const QUIET_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec40";
const QUIET_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec41";
const QUIET_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec42";
const RECOVERY_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec50";
const RECOVERY_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec51";
const RECOVERY_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec52";
const RECOVERY_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec53";

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function signedRequest(
  event: Record<string, unknown>,
  tamper = false,
): Promise<Request> {
  const body = JSON.stringify(event);
  const eventId = event.event_id;
  if (typeof eventId !== "string") {
    throw new Error("Signed test event requires event_id");
  }
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${eventId}.${timestamp}.${body}`),
  );
  return new Request("https://starter.example/webhooks/relay", {
    body: tamper ? `${body} ` : body,
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-signature": `v1,${base64(signature)}`,
      "webhook-timestamp": timestamp,
    },
    method: "POST",
  });
}

function envelope(
  eventId: string,
  eventType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    agent_id: AGENT_ID,
    api_version: "v1",
    created_at: "2026-09-01T12:00:00.000Z",
    data,
    event_id: eventId,
    event_type: eventType,
    trace_id: "starter-workerd-test",
    webhook_version: "2026-08-30",
  };
}

function handle(id: string, handleName: string) {
  return {
    image_url: null,
    display_name: handleName,
    handle: handleName,
    id,
    joined_at: "2026-09-01T12:00:00.000Z",
    kind: "user",
    about: null,
    verified: false,
  };
}

function messageEnvelope(input: {
  chatId: string;
  eventId: string;
  isGroup: boolean;
  mentioned: boolean;
  messageId: string;
}): Record<string, unknown> {
  const parts = input.mentioned
    ? [{
        mention: "starter_test",
        mention_range: [0, "starter_test".length],
        type: "text",
        value: "@starter_test please reply",
      }]
    : [{ type: "text", value: "please reply" }];
  return envelope(input.eventId, "message.received", {
    chat: {
      id: input.chatId,
      is_group: input.isGroup,
      owner_handle: {
        ...handle(AGENT_ID, "starter_test"),
        kind: "agent",
      },
    },
    direction: "inbound",
    id: input.messageId,
    parts,
    sender_handle: handle(USER_ID, "relay_user"),
  });
}

interface RelayRequest {
  body: string;
  headers: Headers;
  method: string;
  pathname: string;
}

interface CommittedRelayMessage {
  body: string;
  messageId: string;
}

/**
 * The adapter derives every inbound send key from the Relay event that caused
 * it, so a redelivery replays under the same key instead of double-posting.
 */
function relaySendKey(eventId: string): string {
  return `relay-chat-sdk:${eventId}:0`;
}

function expectedReplyBody(_eventId: string) {
  // The adapter carries the key in the Idempotency-Key header, so the body is
  // just the message. `expectCanonicalTurn` asserts the header separately.
  return {
    message: {
      parts: [{ type: "text", value: TEST_REPLY_TEXT }],
    },
  };
}

function installRelayBackend(input: {
  chatId: string;
  precommitted?: {
    body: ReturnType<typeof expectedReplyBody>;
    key: string;
    messageId: string;
  };
  replyId: string;
}) {
  const calls: RelayRequest[] = [];
  const committed = new Map<string, CommittedRelayMessage>();
  let newCommits = 0;
  if (input.precommitted) {
    committed.set(input.precommitted.key, {
      body: JSON.stringify(input.precommitted.body),
      messageId: input.precommitted.messageId,
    });
  }

  const fetchMock = vi.fn(async (
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(requestInput, init);
    const body = await request.clone().text();
    const pathname = new URL(request.url).pathname;
    calls.push({
      body,
      headers: new Headers(request.headers),
      method: request.method,
      pathname,
    });

    if (
      pathname === `/v1/chats/${input.chatId}/read`
      && request.method === "POST"
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      pathname === `/v1/chats/${input.chatId}/messages`
      && request.method === "POST"
    ) {
      const key = request.headers.get("idempotency-key");
      if (!key) throw new Error("Relay send omitted Idempotency-Key");
      const previous = committed.get(key);
      if (previous) {
        if (previous.body !== body) {
          return Response.json({
            error: { code: "idempotency_conflict" },
          }, { status: 409 });
        }
        return Response.json({
          chat_id: input.chatId,
          message: { id: previous.messageId },
        }, { status: 202 });
      }
      newCommits += 1;
      committed.set(key, { body, messageId: input.replyId });
      return Response.json({
        chat_id: input.chatId,
        message: { id: input.replyId },
      }, { status: 202 });
    }
    throw new Error(`Unexpected Relay request: ${request.method} ${pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    committed,
    fetchMock,
    newCommits: () => newCommits,
  };
}

function expectCanonicalTurn(
  calls: RelayRequest[],
  chatId: string,
  eventId: string,
): void {
  expect(calls.map(({ method, pathname }) => [method, pathname])).toEqual([
    ["POST", `/v1/chats/${chatId}/read`],
    ["POST", `/v1/chats/${chatId}/messages`],
  ]);
  const send = calls[1]!;
  const key = relaySendKey(eventId);
  expect(send.headers.get("authorization")).toBe("Bearer relay-test-token");
  expect(send.headers.get("idempotency-key")).toBe(key);
  expect(JSON.parse(send.body)).toEqual(expectedReplyBody(eventId));
}

/**
 * The Worker acknowledges before the turn runs, so a test that asserts on the
 * turn has to wait for it rather than for the response.
 */
async function waitForRelayCalls(
  relay: { calls: RelayRequest[] },
  count: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (relay.calls.length < count && Date.now() < deadline) {
    await scheduler.wait(25);
  }
  expect(relay.calls.length).toBeGreaterThanOrEqual(count);
}

function bindings(): Bindings {
  return {
    AI: {} as Ai,
    MODEL_ID: "@cf/openai/gpt-oss-120b",
    RELAY_AGENT_HANDLE: "your_agent_handle",
    RELAY_AGENT_TOKEN: "relay-test-token",
    RELAY_API_ORIGIN: "https://api.staging.relayapp.im",
    RELAY_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQ=",
    RelayChat: {} as DurableObjectNamespace<RelayChatAgent>,
  };
}

afterEach(async () => {
  // Deliveries now outlive the response that started them. Let the in-flight
  // ones finish against their own stubbed backend, or they would run on the
  // next test's stub and be counted as its calls.
  await scheduler.wait(500);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Relay Think messenger", () => {
  it("uses the Worker-routed root Think conversation", () => {
    const messenger = createRelayMessenger(
      bindings(),
      createRelayAdapterFor(bindings()),
    );
    expect(messenger).toMatchObject({
      adapterName: "relay",
      conversation: "self",
      path: "/webhooks/relay",
      provider: "relay",
      respondTo: ["direct-message", "mention"],
      verifyWebhook: false,
    });
  });

  it("buffers visible output and leaves one canonical send to the reply Action", () => {
    const delivery = createRelayMessenger(
      bindings(),
      createRelayAdapterFor(bindings()),
    ).delivery;
    expect(delivery).toMatchObject({
      emptyResponseText: "",
      errorResponseText: "",
      interruptedResponseText: "",
      visibleSoftLimit: 0,
    });
    expect(delivery?.splitText?.("must not be posted")).toEqual([]);
  });

  it("keeps the replaceable model seam to one configured model ID", () => {
    expect(starterModel(bindings())).toBe("@cf/openai/gpt-oss-120b");
  });
});

describe("canonical Relay delivery", () => {
  it("stamps read and cancels a superseded turn on receipt", () => {
    const adapter = createRelayAdapterFor(bindings());
    // Both receipts belong to the adapter now, so there is one Relay client
    // in the Worker and the read cannot wait behind a turn.
    expect(adapter.supportsTurnCancellation).toBe(true);
    expect(adapter.typing).toBe(false);
    expect(adapter.userName).toBe("your_agent_handle");
  });

  it("refuses a send outside an inbound turn rather than inventing a key", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("A keyless Relay send reached the network");
    });
    vi.stubGlobal("fetch", fetchMock);

    // Relay's idempotency key is derived from the event that caused the send.
    // Outside a webhook turn there is no such event, so the adapter refuses
    // instead of minting a key that would change on recovery.
    await expect(sendRelayReply(
      createRelayAdapterFor(bindings()),
      { chatId: CHAT_ID, messageId: MESSAGE_ID },
      "one complete answer",
    )).rejects.toThrow(/idempotencyKeyResolver/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send when the turn was already cancelled", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("A cancelled turn committed its answer");
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(sendRelayReply(
      createRelayAdapterFor(bindings()),
      { chatId: CHAT_ID, messageId: MESSAGE_ID },
      "superseded answer",
      controller.signal,
    )).resolves.toEqual({ status: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("signed messenger turns", () => {
  it("runs Read, model, reply Action, and one Message for a direct Chat", async () => {
    const relay = installRelayBackend({
      chatId: DIRECT_CHAT_ID,
      replyId: DIRECT_REPLY_ID,
    });
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: DIRECT_CHAT_ID,
        eventId: DIRECT_EVENT_ID,
        isGroup: false,
        mentioned: false,
        messageId: DIRECT_MESSAGE_ID,
      })),
    );

    // Acknowledged before the turn, so Relay never times the delivery out.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    await waitForRelayCalls(relay, 2);
    expectCanonicalTurn(relay.calls, DIRECT_CHAT_ID, DIRECT_EVENT_ID);
    expect(relay.committed.size).toBe(1);
    expect(relay.newCommits()).toBe(1);
  });

  it("runs the same canonical turn for a structured group mention", async () => {
    const relay = installRelayBackend({
      chatId: GROUP_CHAT_ID,
      replyId: GROUP_REPLY_ID,
    });
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: GROUP_CHAT_ID,
        eventId: GROUP_EVENT_ID,
        isGroup: true,
        mentioned: true,
        messageId: GROUP_MESSAGE_ID,
      })),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    await waitForRelayCalls(relay, 2);
    expectCanonicalTurn(relay.calls, GROUP_CHAT_ID, GROUP_EVENT_ID);
    expect(relay.committed.size).toBe(1);
    expect(relay.newCommits()).toBe(1);
  });

  it("reclaims a stale Action claim and replays the committed Message", async () => {
    const threadId = `relay:${RECOVERY_CHAT_ID}`;
    const key = relaySendKey(RECOVERY_EVENT_ID);
    const relay = installRelayBackend({
      chatId: RECOVERY_CHAT_ID,
      precommitted: {
        body: expectedReplyBody(RECOVERY_EVENT_ID),
        key,
        messageId: RECOVERY_REPLY_ID,
      },
      replyId: RECOVERY_REPLY_ID,
    });
    const seeded = await SELF.fetch(
      new Request("https://starter.example/__test/action-ledger", {
        body: JSON.stringify({
          messageId: RECOVERY_MESSAGE_ID,
          text: TEST_REPLY_TEXT,
          threadId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(seeded.status).toBe(204);

    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: RECOVERY_CHAT_ID,
        eventId: RECOVERY_EVENT_ID,
        isGroup: false,
        mentioned: false,
        messageId: RECOVERY_MESSAGE_ID,
      })),
    );
    expect(response.status).toBe(202);
    await waitForRelayCalls(relay, 2);
    expectCanonicalTurn(relay.calls, RECOVERY_CHAT_ID, RECOVERY_EVENT_ID);
    expect(relay.newCommits()).toBe(0);
    expect(relay.committed).toEqual(new Map([
      [key, {
        body: JSON.stringify(expectedReplyBody(RECOVERY_EVENT_ID)),
        messageId: RECOVERY_REPLY_ID,
      }],
    ]));

    const ledger = await SELF.fetch(
      `https://starter.example/__test/action-ledger?threadId=${encodeURIComponent(threadId)}`,
    );
    expect(ledger.status).toBe(200);
    expect(await ledger.json()).toMatchObject({
      rows: [{
        key: `action:reply:message:${RECOVERY_MESSAGE_ID}`,
        status: "settled",
      }],
    });
  });
});

describe("installed Worker", () => {
  it("reports a configured health route without exposing secrets", async () => {
    const response = await SELF.fetch("https://starter.example/healthz");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(body).not.toContain("relay-test-token");
  });

  it("rejects a body changed after signing", async () => {
    const response = await SELF.fetch(
      await signedRequest(envelope(EVENT_ID, "chat.created", {}), true),
    );
    expect(response.status).toBe(401);
  });

  it("acknowledges a signed current event through the Relay adapter", async () => {
    const response = await SELF.fetch(
      await signedRequest(envelope(EVENT_ID, "chat.created", {})),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
  });

  it("acknowledges and reads but starts no turn for an unmentioned group Message", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: QUIET_CHAT_ID,
        eventId: QUIET_EVENT_ID,
        isGroup: true,
        mentioned: false,
        messageId: QUIET_MESSAGE_ID,
      })),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    // The acknowledgement is immediate, so give the background delivery real
    // time to reach Relay before asserting what it did.
    await scheduler.wait(2_000);
    // Read is a receipt about delivery and is stamped for every inbound
    // message. Answering is what a mention gates, and no Message was sent.
    expect(paths).toEqual([`/v1/chats/${QUIET_CHAT_ID}/read`]);
  });
});
