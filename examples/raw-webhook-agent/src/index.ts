import { createServer } from "node:http";
import {
  createRelayClient,
  isVisibleMessage,
  MemoryDedupe,
  replyIdempotencyKey,
  verifyWebhookSignature,
  type MessageReceivedEvent,
} from "@relaymessenger/sdk";

const token = process.env.RELAY_AGENT_TOKEN;
const secret = process.env.RELAY_WEBHOOK_SECRET;
const port = Number(process.env.PORT ?? 8787);

if (!token || !secret) {
  console.error("Set RELAY_AGENT_TOKEN and RELAY_WEBHOOK_SECRET");
  process.exit(1);
}

const client = createRelayClient({ token });
const dedupe = new MemoryDedupe();

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");

  // Verify the Standard Webhooks signature over the exact raw body.
  try {
    await verifyWebhookSignature({
      secret,
      payload: body,
      headers: {
        "webhook-id": req.headers["webhook-id"] as string | undefined,
        "webhook-timestamp": req.headers["webhook-timestamp"] as string | undefined,
        "webhook-signature": req.headers["webhook-signature"] as string | undefined,
      },
    });
  } catch {
    res.writeHead(401).end("signature rejected");
    return;
  }

  const event = JSON.parse(body) as MessageReceivedEvent;
  if (event.event_type !== "message.received") {
    res.writeHead(200).end();
    return;
  }
  // Delivery is at least once: a replayed event_id was already answered.
  if (dedupe.has(event.event_id)) {
    res.writeHead(200).end();
    return;
  }

  // Acknowledge on receipt, then work.
  //
  // Relay stamps the sender's Delivered receipt on THIS response. The rung
  // means "your endpoint has the message", not "your agent has finished
  // thinking about it", so holding the response through a model call spends
  // the sender's receipt on work they cannot see: the slower your turn, the
  // longer they watch a message with nothing underneath it.
  //
  // The order below is what makes the acknowledgement honest rather than
  // merely fast. Verify the signature, reject a replay, hand the event
  // somewhere it will outlive this request, and only then answer. Everything
  // before the 200 is Relay's problem; everything after it is yours.
  accept(event);
  res.writeHead(200).end();
}).listen(port, () => {
  console.log(`[raw-webhook] listening on :${port}`);
});

/**
 * Takes ownership of one event and starts working on it.
 *
 * This is the one function to replace for production. An in-process queue is
 * lost on a crash or a redeploy, and once you have answered 200 Relay will not
 * send the event again — a 2xx ends its delivery. Acknowledging first moves
 * retries from Relay to you, so the handoff has to be to something durable
 * before that trade is a good one: a queue, a job table, a Durable Object.
 * With one of those in place the acknowledgement is a promise you can keep.
 */
function accept(event: MessageReceivedEvent): void {
  // Recorded before the work, not after: the record is what makes a redelivery
  // a no-op, and after a 200 there is no redelivery to catch it later.
  dedupe.record(event.event_id);
  void respond(event).catch((error) => {
    console.error("[raw-webhook] handler failed after acknowledgement", error);
  });
}

async function respond(event: MessageReceivedEvent): Promise<void> {
  const message = event.data.message;
  // A replayed event can carry a tombstone for a message that has since been
  // unsent, and a tombstone has no parts to echo.
  if (!isVisibleMessage(message)) return;
  const invocationId = event.data.invocation_id;
  try {
    // Read is the rung you control, and it is a different claim from
    // Delivered: this says the agent is engaged with the message, which is
    // true from here on. Delivered was already recorded by the 200 above.
    await client.setResponding({
      conversationId: message.conversation_id,
      messageId: message.id,
      ...(invocationId ? { invocationId } : {}),
    });
    const text =
      message.parts.find((part) => part.type === "text")?.text ?? "(empty)";
    await client.sendText({
      conversationId: message.conversation_id,
      text: `Webhook echo: ${text}`,
      // Derived from event_id, so a retry replays the same send instead of
      // double-posting. That is what makes retrying safe now that retrying is
      // your job.
      idempotencyKey: replyIdempotencyKey(event.event_id),
      ...(invocationId ? { invocationId } : {}),
    });
  } finally {
    // Always, even on the failure path: a typist left raised over a reply that
    // never came is worse than no typist at all.
    await client.setTyping({
      conversationId: message.conversation_id,
      started: false,
      ...(invocationId ? { invocationId } : {}),
    }).catch(() => {});
  }
}
