import { createServer } from "node:http";
import {
  createRelayClient,
  MemoryDedupe,
  replyIdempotencyKey,
  verifyWebhookSignature,
  type MessageReceivedEvent,
} from "@relaymessenger/core";

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

  res.writeHead(202).end();

  const event = JSON.parse(body) as MessageReceivedEvent;
  if (event.event_type !== "message.received") return;
  if (dedupe.has(event.event_id)) return;

  const message = event.data.message;
  const invocationId = event.data.invocation_id;
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
      idempotencyKey: replyIdempotencyKey(event.event_id),
      ...(invocationId ? { invocationId } : {}),
    });
    dedupe.record(event.event_id);
  } finally {
    await client.setTyping({
      conversationId: message.conversation_id,
      started: false,
      ...(invocationId ? { invocationId } : {}),
    });
  }
}).listen(port, () => {
  console.log(`[raw-webhook] listening on :${port}`);
});
