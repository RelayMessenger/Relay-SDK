#!/usr/bin/env node

import { createServer } from "node:http";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { Chat } from "chat";

const relay = createRelayAdapter({
  typing: process.env.RELAY_DISABLE_AUTOMATIC_TYPING !== "1",
});

const chat = new Chat({
  adapters: { relay },
  logger: "info",
  state: createMemoryState(),
  userName: "Relay Chat SDK example",
});

chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Echo: ${message.text}`);
});

if (process.env.RELAY_EXAMPLE_CHECK === "1") {
  console.log(
    `example ok: ${relay.name}, typing=${String(relay.typing)}`,
  );
  process.exit(0);
}

const port = Number(process.env.PORT ?? 3000);
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? `localhost:${port}`}`,
    );
    if (url.pathname !== "/webhooks/relay") {
      outgoing.writeHead(404).end("Not found");
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 1_048_576) {
        outgoing.writeHead(413).end("Payload too large");
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(url, {
      body: Buffer.concat(chunks),
      headers: incoming.headers,
      method: incoming.method,
    });
    const response = await chat.webhooks.relay(request);
    outgoing.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500).end("Internal error");
  }
});

server.listen(port, () => {
  console.log(`Relay webhook listening on http://localhost:${port}/webhooks/relay`);
});
