import { parseArgs } from "node:util";

import Relay from "@relaymessenger/sdk";

import { relayApiOrigin } from "./config.js";
import { sendTextMessage } from "./send.js";

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

const { values } = parseArgs({
  options: {
    "chat-id": { type: "string" },
    "idempotency-key": { type: "string" },
    text: { type: "string" },
  },
  strict: true,
});

const relay = new Relay({
  apiKey: required(process.env.RELAY_AGENT_TOKEN, "RELAY_AGENT_TOKEN"),
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});
const result = await sendTextMessage(relay, {
  chatId: required(values["chat-id"], "--chat-id"),
  idempotencyKey: required(
    values["idempotency-key"],
    "--idempotency-key",
  ),
  text: required(values.text, "--text"),
});

console.log(JSON.stringify(result, null, 2));
