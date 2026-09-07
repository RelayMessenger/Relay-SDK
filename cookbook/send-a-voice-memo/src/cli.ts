import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import Relay from "@relaymessenger/sdk";

import { relayApiOrigin } from "./config.js";
import {
  sendVoiceMemo,
  type AudioContentType,
} from "./send.js";

const AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/x-m4a",
  "audio/mp4",
  "audio/x-caf",
  "audio/x-wav",
  "audio/x-aiff",
  "audio/aiff",
  "audio/aac",
  "audio/midi",
  "audio/amr",
] as const satisfies readonly AudioContentType[];

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

function audioContentType(value: string | undefined): AudioContentType {
  const candidate = required(value, "--content-type");
  if (!(AUDIO_TYPES as readonly string[]).includes(candidate)) {
    throw new Error(
      `--content-type must be one of: ${AUDIO_TYPES.join(", ")}`,
    );
  }
  return candidate as AudioContentType;
}

const { values } = parseArgs({
  options: {
    "chat-id": { type: "string" },
    "content-type": { type: "string" },
    file: { type: "string" },
  },
  strict: true,
});

const file = required(values.file, "--file");
const relay = new Relay({
  apiKey: required(process.env.RELAY_AGENT_TOKEN, "RELAY_AGENT_TOKEN"),
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});
const result = await sendVoiceMemo(relay, {
  audio: {
    bytes: await readFile(file),
    contentType: audioContentType(values["content-type"]),
    filename: basename(file),
  },
  chatId: required(values["chat-id"], "--chat-id"),
});

console.log(JSON.stringify(result, null, 2));
