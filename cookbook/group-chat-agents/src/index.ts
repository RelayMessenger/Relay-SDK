import { verifyWebhookSignature } from "@relaymessenger/chat-sdk-adapter";
import { getAgentByName } from "agents";

import { RELAY_WEBHOOK_PATH } from "./agent";
import { type Bindings, configurationErrors, required } from "./env";

export { GroupChatAgent, ThinkMessengerStateAgent } from "./agent";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The Chat a signed webhook is about, which names its Durable Object. */
export function chatIdOf(payload: string): string | null {
  try {
    const data = (JSON.parse(payload) as { data?: { chat?: { id?: unknown }; chat_id?: unknown } }).data;
    const id = data?.chat?.id ?? data?.chat_id;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function routeWebhook(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
  const payload = await request.text();
  try {
    await verifyWebhookSignature({ headers: request.headers, payload, secret: required(env.RELAY_WEBHOOK_SECRET, "RELAY_WEBHOOK_SECRET") });
  } catch {
    return Response.json({ error: { code: "invalid_signature" } }, { status: 401 });
  }
  const chatId = chatIdOf(payload);
  if (!chatId) return Response.json({ accepted: true, turn: false });
  const agent = await getAgentByName(env.GroupChat, chatId);
  // Answer Relay now; the turn, and any wait for the agents ahead, outlive a
  // webhook timeout.
  ctx.waitUntil(agent.fetch(new Request(request.url, { method: "POST", headers: request.headers, body: payload }))
    .then(() => undefined, (error: unknown) => {
      console.warn(JSON.stringify({ event: "relay_delivery_failed", error_type: error instanceof Error ? error.name : typeof error }));
    }));
  return Response.json({ accepted: true }, { status: 202 });
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      const errors = configurationErrors(env);
      return Response.json(errors.length ? { ok: false, details: errors } : { ok: true }, { status: errors.length ? 503 : 200 });
    }
    if (url.pathname === RELAY_WEBHOOK_PATH) return routeWebhook(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
