import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import Relay from "@relaymessenger/sdk";

import { relayApiOrigin } from "./config.js";
import {
  sendImage,
  type ImageContentType,
} from "./send.js";

const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "image/webp",
  "image/x-icon",
] as const satisfies readonly ImageContentType[];

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

function imageContentType(value: string | undefined): ImageContentType {
  const candidate = required(value, "--content-type");
  if (!(IMAGE_TYPES as readonly string[]).includes(candidate)) {
    throw new Error(
      `--content-type must be one of: ${IMAGE_TYPES.join(", ")}`,
    );
  }
  return candidate as ImageContentType;
}

const { values } = parseArgs({
  options: {
    "chat-id": { type: "string" },
    "content-type": { type: "string" },
    file: { type: "string" },
    "idempotency-key": { type: "string" },
  },
  strict: true,
});

const file = required(values.file, "--file");
const relay = new Relay({
  apiKey: required(process.env.RELAY_AGENT_TOKEN, "RELAY_AGENT_TOKEN"),
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});
const result = await sendImage(relay, {
  chatId: required(values["chat-id"], "--chat-id"),
  image: {
    bytes: await readFile(file),
    contentType: imageContentType(values["content-type"]),
    filename: basename(file),
  },
  idempotencyKey: required(
    values["idempotency-key"],
    "--idempotency-key",
  ),
});

console.log(JSON.stringify(result, null, 2));
