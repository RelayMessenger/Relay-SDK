import { readFile } from "node:fs/promises";

import Relay, { type RelayWebhookEvent } from "@relaymessenger/sdk";

import { answer, CHARACTER, setProfilePicture } from "./agent.js";
import { relayApiOrigin } from "./config.js";
import { imageType, type ChatMessage, type Media, Xai } from "./xai.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const relay = new Relay({
  apiKey: required("RELAY_AGENT_TOKEN"),
  baseURL: relayApiOrigin(process.env.RELAY_API_URL),
});
const xai = new Xai({
  apiKey: required("XAI_API_KEY"),
  ...(process.env.XAI_MODEL ? { model: process.env.XAI_MODEL } : {}),
});

// The reference picture keeps the character's look the same everywhere.
// Without one, Grok Imagine draws a first portrait from the description.
const referencePath = process.env.REFERENCE_IMAGE?.trim();
let reference: Media;
if (referencePath) {
  const bytes = new Uint8Array(await readFile(referencePath));
  reference = { bytes, contentType: imageType(bytes), filename: "reference" };
} else {
  reference = await xai.generate(`${CHARACTER}. Head and shoulders, facing the camera, plain background.`);
}

const card = await setProfilePicture(relay, xai, reference);
console.log(JSON.stringify({ event: "profile_picture_set", handle: card.handle, image_url: card.image_url }));

const histories = new Map<string, ChatMessage[]>();
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());

await relay.websocket.run({
  signal: abort.signal,
  onConnectionState(state) {
    console.log(JSON.stringify({ event: "relay_websocket", state }));
  },
  async onEvent(event: RelayWebhookEvent) {
    if (event.event_type !== "message.received") return;
    const data = event.data;
    if (data.direction !== "inbound" || data.chat.is_group) return;
    const text = data.parts
      .map((part) => (part.type === "text" || part.type === "link" ? part.value : ""))
      .join("\n")
      .trim();
    if (!text) return;
    const history = histories.get(data.chat.id) ?? [];
    histories.set(data.chat.id, history);
    history.push({ role: "user", content: text });
    await relay.chats.startTyping(data.chat.id).catch(() => undefined);
    const sent = await answer(relay, xai, reference, data.chat.id, history, event.event_id);
    console.log(JSON.stringify({ event: "answered", chat_id: data.chat.id, message_ids: sent }));
  },
  // A FULL sync means Relay could not replay every event: start each chat afresh.
  async onFullSync() {
    histories.clear();
  },
  onError(error) {
    console.error(JSON.stringify({ event: "relay_websocket_reconnect", error: String(error) }));
  },
});
