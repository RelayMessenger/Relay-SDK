#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);
let observed;

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  observed = {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    idempotencyKey: request.headers["idempotency-key"],
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      chat_id: "chat-example",
      message: {
        id: "message-example",
        parts: [
          {
            type: "text",
            value: "Hello from the package test.",
            reactions: null,
          },
        ],
        created_at: "2026-09-01T00:00:00.000Z",
        sent_at: "2026-09-01T00:00:00.000Z",
        delivery_status: "sent",
        is_system_message: false,
      },
    }),
  );
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { stdout } = await run(
    process.execPath,
    ["examples/send-message/index.mjs"],
    {
      env: {
        ...process.env,
        RELAY_API_URL: `http://127.0.0.1:${address.port}`,
        RELAY_AGENT_TOKEN: "test-agent-token",
        RELAY_CHAT_ID: "chat-example",
        RELAY_MESSAGE_TEXT: "Hello from the package test.",
        RELAY_IDEMPOTENCY_KEY: "example-idempotency-key",
      },
    },
  );
  assert.deepEqual(JSON.parse(stdout), {
    chat_id: "chat-example",
    message_id: "message-example",
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}

assert.deepEqual(observed, {
  method: "POST",
  url: "/v1/chats/chat-example/messages",
  authorization: "Bearer test-agent-token",
  idempotencyKey: "example-idempotency-key",
  body: {
    message: {
      parts: [{ type: "text", value: "Hello from the package test." }],
      idempotency_key: "example-idempotency-key",
    },
  },
});

let unsafeOriginFailure = "";
try {
  await run(process.execPath, ["examples/send-message/index.mjs"], {
    env: {
      ...process.env,
      RELAY_API_URL: "http://example.com",
      RELAY_AGENT_TOKEN: "must-not-leave-process",
      RELAY_CHAT_ID: "chat-example",
      RELAY_IDEMPOTENCY_KEY: "example-idempotency-key",
    },
  });
} catch (error) {
  unsafeOriginFailure = `${error.message}\n${error.stderr ?? ""}`;
}
assert.match(unsafeOriginFailure, /HTTPS; HTTP is loopback-only/);
assert.doesNotMatch(unsafeOriginFailure, /must-not-leave-process/);

console.log("verified current Relay SDK example request and response");
