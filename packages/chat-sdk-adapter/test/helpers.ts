import type {
  RelayChatHandle,
  RelayReactionEvent,
  RelayWebhookEnvelope,
  RelayWebhookEventType,
  RelayWebhookMessageEvent,
} from "../src/index.js";

export const IDS = {
  agent: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  attachment: "99999999-9999-4999-8999-999999999999",
  chat: "11111111-1111-4111-8111-111111111111",
  event: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  message: "22222222-2222-4222-8222-222222222222",
  otherChat: "33333333-3333-4333-8333-333333333333",
  reply: "44444444-4444-4444-8444-444444444444",
  user: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const secretBytes = new TextEncoder().encode(
  "relay-chat-sdk-adapter-test-secret",
);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const WEBHOOK_SECRET = `whsec_${bytesToBase64(secretBytes)}`;

export const USER_HANDLE: RelayChatHandle = {
  avatar_url: null,
  display_name: "Ada",
  handle: "ada",
  id: IDS.user,
  is_me: false,
  joined_at: "2026-08-30T12:00:00.000Z",
  kind: "user",
  status: "active",
  tagline: null,
  verified: false,
};

export const AGENT_HANDLE: RelayChatHandle = {
  avatar_url: null,
  display_name: "Relay Agent",
  handle: "relay-agent",
  id: IDS.agent,
  is_me: true,
  joined_at: "2026-08-30T12:00:00.000Z",
  kind: "agent",
  status: "active",
  tagline: "Helpful",
  verified: true,
};

export function webhookMessage(
  overrides: Partial<RelayWebhookMessageEvent> = {},
): RelayWebhookMessageEvent {
  return {
    chat: { id: IDS.chat, is_group: false, owner_handle: USER_HANDLE },
    delivered_at: null,
    direction: "inbound",
    id: IDS.message,
    idempotency_key: null,
    parts: [{ type: "text", value: "hello Relay" }],
    read_at: null,
    reply_to: null,
    sender_handle: USER_HANDLE,
    sent_at: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

export function reactionEvent(
  overrides: Partial<RelayReactionEvent> = {},
): RelayReactionEvent {
  return {
    chat_id: IDS.chat,
    from_handle: USER_HANDLE,
    is_from_me: false,
    message_id: IDS.message,
    part_index: 0,
    reacted_at: "2026-08-30T12:00:01.000Z",
    reaction_type: "like",
    ...overrides,
  };
}

export function envelope(
  eventType: RelayWebhookEventType = "message.received",
  data: Record<string, unknown> = webhookMessage() as unknown as Record<
    string,
    unknown
  >,
  overrides: Partial<RelayWebhookEnvelope> = {},
): RelayWebhookEnvelope {
  return {
    agent_id: IDS.agent,
    api_version: "v1",
    created_at: "2026-08-30T12:00:01.000Z",
    data,
    event_id: IDS.event,
    event_type: eventType,
    trace_id: "trace-chat-sdk-test",
    webhook_version: "2026-08-30",
    ...overrides,
  };
}

export async function signedRequest(
  value: unknown,
  options: {
    secret?: string;
    timestamp?: number;
    webhookId?: string;
  } = {},
): Promise<Request> {
  const body = JSON.stringify(value);
  const timestamp = String(
    options.timestamp ?? Math.floor(Date.now() / 1_000),
  );
  const webhookId = options.webhookId ?? IDS.event;
  const secret = options.secret ?? WEBHOOK_SECRET;
  const encoded = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  const binary = atob(encoded);
  const keyBytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    keyBytes[index] = binary.charCodeAt(index);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `${webhookId}.${timestamp}.${body}`,
      ),
    ),
  );
  return new Request("https://agent.example.test/webhooks/relay", {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-signature": `v1,${bytesToBase64(signature)}`,
      "webhook-timestamp": timestamp,
    },
    method: "POST",
  });
}

export function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  if (status === 204) return new Response(null, { status });
  return Response.json(body, { status });
}
