import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import Relay, { type SupportedContentType } from "@relaymessenger/sdk";

import { sendMessageWithAttachment } from "./send.js";
import { relayApiOrigin } from "./config.js";

const SUPPORTED_TYPES = [
  "application/json",
  "application/pdf",
  "application/zip",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/markdown",
  "text/plain",
] as const satisfies readonly SupportedContentType[];

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

function contentType(value: string | undefined): SupportedContentType {
  const candidate = required(value, "--content-type");
  if (!(SUPPORTED_TYPES as readonly string[]).includes(candidate)) {
    throw new Error(
      `--content-type must be one of: ${SUPPORTED_TYPES.join(", ")}`,
    );
  }
  return candidate as SupportedContentType;
}

const { values } = parseArgs({
  options: {
    "chat-id": { type: "string" },
    "content-type": { type: "string" },
    file: { type: "string" },
    "idempotency-key": { type: "string" },
    text: { type: "string" },
  },
  strict: true,
});

const file = required(values.file, "--file");
const relay = new Relay({
  apiKey: required(process.env.RELAY_AGENT_TOKEN, "RELAY_AGENT_TOKEN"),
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});
const result = await sendMessageWithAttachment(relay, {
  chatId: required(values["chat-id"], "--chat-id"),
  file: {
    bytes: await readFile(file),
    contentType: contentType(values["content-type"]),
    filename: basename(file),
  },
  idempotencyKey: required(
    values["idempotency-key"],
    "--idempotency-key",
  ),
  ...(values.text ? { text: values.text } : {}),
});

console.log(JSON.stringify(result, null, 2));
