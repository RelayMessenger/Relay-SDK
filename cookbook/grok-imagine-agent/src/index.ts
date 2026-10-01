import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import Relay, { type RelayWebhookEvent } from "@relaymessenger/sdk";

import { answer, CHARACTER, setProfilePicture } from "./agent.js";
import { relayApiOrigin } from "./config.js";
import { ProgressStore } from "./store.js";
import { imageType, type Media, Xai } from "./xai.js";

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
const store = new ProgressStore(
  process.env.RELAY_STATE_PATH?.trim() || join(homedir(), ".relay", "examples", "grok-imagine-agent", "state.db"),
);

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

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());

try {
  await relay.websocket.run({
    signal: abort.signal,
    onConnectionState(state) {
      console.log(JSON.stringify({ event: "relay_websocket", state }));
    },
    async onEvent(event: RelayWebhookEvent) {
      if (event.event_type !== "message.received") return;
      const data = event.data;
      if (data.direction !== "inbound") return;
      const words = data.parts
        .map((part) => (part.type === "text" || part.type === "link" ? part.value : ""))
        .join("\n")
        .trim();
      if (!words) return;
      // In a group, Grok reads who said it and decides whether to answer.
      const speaker = data.sender_handle.display_name?.trim() || data.sender_handle.handle;
      const text = data.chat.is_group ? `${speaker} (in a group chat): ${words}` : words;
      await relay.chats.startTyping(data.chat.id).catch(() => undefined);
      await answer({ relay, xai, store, reference }, { eventId: event.event_id, chatId: data.chat.id, text });
      console.log(JSON.stringify({ event: "answered", event_id: event.event_id, chat_id: data.chat.id }));
    },
    // A FULL sync means Relay could not replay every event: start each chat afresh.
    async onFullSync() {
      store.clearChats();
    },
    onError(error) {
      console.error(JSON.stringify({ event: "relay_websocket_reconnect", error: String(error) }));
    },
  });
} finally {
  store.close();
}
