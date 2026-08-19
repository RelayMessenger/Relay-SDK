import { createServer } from "node:http";
import {
  createRelayClient,
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

  const message = event.data.message;
  const invocationId = event.data.invocation_id;
  // Reply before acknowledging. Relay retries only on 408/429/5xx, so a 2xx
  // sent before the work is done would turn any crash into a lost event.
  try {
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
      // Derived from event_id, so a redelivered event replays the same send
      // instead of double-posting.
      idempotencyKey: replyIdempotencyKey(event.event_id),
      ...(invocationId ? { invocationId } : {}),
    });
    await client.setTyping({
      conversationId: message.conversation_id,
      started: false,
      ...(invocationId ? { invocationId } : {}),
    });
  } catch (error) {
    console.error("[raw-webhook] handler failed", error);
    // 5xx tells Relay to redeliver; the dedupe window was not recorded, so
    // the retry is handled again.
    res.writeHead(500).end();
    return;
  }
  // Record the event_id only after the reply succeeded, then acknowledge.
  dedupe.record(event.event_id);
  res.writeHead(200).end();
}).listen(port, () => {
  console.log(`[raw-webhook] listening on :${port}`);
});
