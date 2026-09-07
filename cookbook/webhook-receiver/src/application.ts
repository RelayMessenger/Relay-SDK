import {
  RELAY_WEBHOOK_EVENT_TYPES,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";

const EVENT_TYPES = new Set<string>(RELAY_WEBHOOK_EVENT_TYPES);

export interface WebhookApplicationDependencies {
  accept(event: RelayWebhookEvent): boolean;
  unwrap(rawBody: string, headers: Headers): unknown;
  wake(): void;
}

function currentEvent(value: unknown): value is RelayWebhookEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    event.api_version === "v1"
    && event.webhook_version === "2026-08-30"
    && typeof event.event_id === "string"
    && event.event_id.length > 0
    && typeof event.event_type === "string"
    && EVENT_TYPES.has(event.event_type)
    && event.data !== null
    && typeof event.data === "object"
    && !Array.isArray(event.data)
  );
}

export function createWebhookApplication(
  dependencies: WebhookApplicationDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/webhooks/relay") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    const rawBody = await request.text();
    let value: unknown;
    try {
      value = dependencies.unwrap(rawBody, request.headers);
    } catch {
      return new Response("Signature rejected", { status: 401 });
    }
    if (!currentEvent(value)) {
      return new Response("Unsupported Relay event", { status: 400 });
    }

    const inserted = dependencies.accept(value);
    if (inserted) dependencies.wake();
    return new Response(null, { status: 204 });
  };
}
