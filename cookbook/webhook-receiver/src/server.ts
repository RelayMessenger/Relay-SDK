import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import Relay from "@relaymessenger/sdk";

import { createWebhookApplication } from "./application.js";
import { accountScope, relayApiOrigin } from "./config.js";
import { DurableInbox } from "./inbox.js";
import { InboxProcessor } from "./processor.js";

const MAX_BODY_BYTES = 8 * 1_048_576;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_BODY_BYTES) {
      throw new RangeError("Webhook body exceeds 8 MiB");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function headersFrom(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

const token = requiredEnvironment("RELAY_AGENT_TOKEN");
const origin = relayApiOrigin(process.env.RELAY_API_URL);
const relay = new Relay({
  apiKey: token,
  webhookSecret: requiredEnvironment("RELAY_WEBHOOK_SECRET"),
  baseURL: origin,
});
const inbox = new DurableInbox(
  process.env.RELAY_INBOX_PATH?.trim()
    || join(homedir(), ".relay", "examples", "webhook", "inbox.db"),
  accountScope(origin, token),
);
const processor = new InboxProcessor(inbox, relay);
const application = createWebhookApplication({
  accept: (event) => inbox.accept(event),
  unwrap: (body, headers) => relay.webhooks.unwrap(body, { headers }),
  wake: () => processor.wake(),
});
processor.start();

const port = Number(process.env.PORT ?? 8787);
const server = createServer(async (incoming, outgoing) => {
  try {
    const body = await boundedBody(incoming);
    const request = new Request(
      new URL(
        incoming.url ?? "/",
        `http://${incoming.headers.host ?? `localhost:${port}`}`,
      ),
      {
        method: incoming.method ?? "GET",
        headers: headersFrom(incoming),
        ...(body.byteLength > 0
          ? { body: Uint8Array.from(body).buffer }
          : {}),
      },
    );
    const response = await application(request);
    outgoing.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 500;
    outgoing.writeHead(status).end(
      status === 413 ? "Payload too large" : "Internal error",
    );
  }
});

server.listen(port, () => {
  console.log(
    JSON.stringify({
      event: "relay_webhook_listening",
      path: "/webhooks/relay",
      port,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      processor.stop();
      inbox.close();
      process.exitCode = 0;
    });
  });
}
