import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type Relay from "@relaymessenger/sdk";
import type { MediaPartResponse, MessageWebhookData, RelayWebhookEvent } from "@relaymessenger/sdk";
import { repliedContext, sendToChat, wordsOf } from "./index.js";
import { downloadMedia } from "./session.js";
import type { Transcribe } from "./voice.js";

/*
 * The adapter shape pi-channels takes on `channel:register`, copied from
 * @e9n/pi-channels src/types.ts (ChannelAdapter, ChannelMessage,
 * IncomingMessage). pi-channels is an optional peer, so its types are not
 * imported.
 */
export interface ChannelMessage {
  readonly adapter: string;
  /** The Relay chat id. */
  readonly recipient: string;
  readonly text?: string;
  readonly source?: string;
  readonly metadata?: Record<string, unknown>;
}
export interface IncomingAttachment {
  readonly type: "image" | "document" | "audio";
  readonly path: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
}
export interface IncomingMessage {
  readonly adapter: string;
  /** The Relay chat id, so a reply to the sender goes back to the chat. */
  readonly sender: string;
  readonly text: string;
  readonly attachments?: IncomingAttachment[];
  readonly metadata?: Record<string, unknown>;
}
export interface ChannelAdapter {
  readonly direction: "outgoing" | "incoming" | "bidirectional";
  send(message: ChannelMessage): Promise<void>;
  start(onMessage: (message: IncomingMessage) => void): Promise<void>;
  stop(): Promise<void>;
  sendTyping(recipient: string): Promise<void>;
}

/** The adapter name routes and the chat bridge use. */
export const RELAY_ADAPTER = "relay";

export interface RelayAdapterOptions {
  readonly relay: Relay;
  /** Handles whose Messages are received; any sender when empty or absent. */
  readonly senders?: readonly string[];
  /** Words for a voice note. Without it a voice note is named, not heard. */
  readonly transcribe?: Transcribe;
  /** Where downloaded photos and files go; pi-channels' Telegram adapter uses the same folder. */
  readonly downloadDir?: string;
}

/** Inbound Messages from a Handle, and only the listed Handles when there is a list. */
const received = (event: RelayWebhookEvent, senders: readonly string[] = []): event is RelayWebhookEvent & { data: MessageWebhookData } => {
  if (event.event_type !== "message.received" || event.data.direction !== "inbound") return false;
  const data = event.data as MessageWebhookData;
  if (!data.sender_handle) return false;
  if (!senders.length) return true;
  const handle = (value: string): string => value.replace(/^@/u, "").toLowerCase();
  return senders.some((sender) => handle(sender) === handle(data.sender_handle!.handle));
};

/**
 * One Relay Message as a pi-channels incoming message: its words, the
 * Message it replies to, voice notes as their transcript, and photos and
 * files downloaded to a temporary path as attachments (as pi-channels'
 * Telegram adapter does). Null for a Message with nothing in it.
 */
export const incomingMessage = async (
  relay: Relay,
  event: RelayWebhookEvent & { data: MessageWebhookData },
  options: Pick<RelayAdapterOptions, "transcribe" | "downloadDir"> = {},
): Promise<IncomingMessage | null> => {
  const data = event.data;
  const lines: string[] = [];
  const attachments: IncomingAttachment[] = [];
  for (const part of data.parts) {
    if (part.type !== "media") continue;
    const media = part as MediaPartResponse;
    const mime = String(media.mime_type ?? "").toLowerCase();
    const name = media.filename || "file";
    if (mime.startsWith("audio/")) {
      const words = options.transcribe
        ? await downloadMedia(relay, media).then((bytes) => options.transcribe!(bytes, name)).catch(() => undefined)
        : undefined;
      lines.push(words ? `[voice note, transcribed]: ${words}` : `[voice note: ${name}, could not be transcribed]`);
      continue;
    }
    try {
      const bytes = await downloadMedia(relay, media);
      const dir = options.downloadDir ?? join(tmpdir(), "pi-channels");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${randomUUID()}${extname(name)}`);
      await writeFile(path, bytes);
      attachments.push({ type: mime.startsWith("image/") ? "image" : "document", path, filename: name, ...(mime ? { mimeType: mime } : {}), size: bytes.length });
    } catch {
      lines.push(`[file: ${name}, could not be downloaded]`);
    }
  }
  const text = [wordsOf(data), lines.join("\n"), await repliedContext(relay, data)].filter(Boolean).join("\n\n");
  if (!text && !attachments.length) return null;
  return {
    adapter: RELAY_ADAPTER,
    sender: data.chat.id,
    text,
    ...(attachments.length ? { attachments } : {}),
    metadata: {
      eventId: event.event_id,
      messageId: data.id,
      chatId: data.chat.id,
      isGroup: data.chat.is_group,
      handle: data.sender_handle?.handle,
      handleKind: data.sender_handle?.kind,
    },
  };
};

/**
 * Relay as a pi-channels adapter. Incoming Messages arrive on the Agent's
 * Relay WebSocket; outgoing text goes to the chat named as the recipient
 * through `chats.messages.send`, with fenced blocks (buttons, selection,
 * place, ...) sent as their parts by the SDK's answer parser.
 */
export const relayChannelAdapter = (options: RelayAdapterOptions): ChannelAdapter => {
  const { relay } = options;
  const seen = new Set<string>();
  let stop: AbortController | undefined;
  return {
    direction: "bidirectional",
    async send(message) {
      if (!message.recipient) throw new Error("Relay needs a chat id as the recipient");
      const text = message.text?.trim();
      if (!text) return;
      const key = typeof message.metadata?.idempotencyKey === "string" ? message.metadata.idempotencyKey : `pi-channels-${randomUUID()}`;
      await sendToChat(relay, message.recipient, key, text);
    },
    async start(onMessage) {
      if (stop) return;
      const controller = new AbortController();
      stop = controller;
      void relay.websocket.run({
        signal: controller.signal,
        onEvent: async (event) => {
          if (seen.has(event.event_id) || !received(event, options.senders)) return;
          const incoming = await incomingMessage(relay, event, options);
          seen.add(event.event_id);
          if (incoming) onMessage(incoming);
        },
        // pi-channels keeps no inbox to rebuild from.
        onFullSync: async () => { console.error("Relay: FULL sync acknowledged; Messages sent while pi-channels was away were not delivered."); },
        onError: (error: unknown) => { console.error(`Relay: ${error instanceof Error ? error.message : String(error)}`); },
      }).catch((error: unknown) => {
        console.error(`Relay: the pi-channels adapter stopped: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { if (stop === controller) stop = undefined; });
    },
    async stop() {
      stop?.abort();
      stop = undefined;
    },
    async sendTyping(recipient) {
      await relay.chats.startTyping(recipient);
    },
  };
};

/** The part of Pi's event bus the adapter uses (Pi docs/extensions.md, pi.events). */
export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/**
 * Registers the adapter with pi-channels when it is loaded and does not
 * already hold one by that name. pi-channels answers `channel:list` and
 * `channel:register` through their callbacks synchronously, so no answer
 * means it is not installed. Returns whether the adapter is registered now.
 */
export const registerRelayAdapter = (events: EventBus, adapter: () => ChannelAdapter, name = RELAY_ADAPTER): boolean => {
  let listed: { name: string; type: string }[] | undefined;
  events.emit("channel:list", { callback: (items: { name: string; type: string }[]) => { listed = items; } });
  if (!listed) return false;
  if (listed.some((item) => item.type === "adapter" && item.name === name)) return false;
  let ok = false;
  events.emit("channel:register", { name, adapter: adapter(), callback: (result: boolean) => { ok = result; } });
  return ok;
};
