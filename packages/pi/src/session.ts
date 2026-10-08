import { readFileSync, writeFileSync } from "node:fs";
import Relay, {
  type MediaPartResponse,
  type MessageWebhookData,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { piPrompt, repliedContext, sendAnswer, wordsOf } from "./index.js";
import type { Transcribe } from "./voice.js";

export interface TextBlock { readonly type: "text"; readonly text: string }
export interface ImageBlock { readonly type: "image"; readonly data: string; readonly mimeType: string }
/** One Message as the session reads it: the words, then each photo as an image. */
export type SessionContent = (TextBlock | ImageBlock)[];

/** What the session is given in place of the Pi it would otherwise start. */
export interface SessionPi {
  sendUserMessage(content: SessionContent, options?: { deliverAs: "followUp" | "steer" }): void;
}

export interface SessionChannelOptions {
  readonly agentToken: string;
  readonly baseURL?: string;
  readonly relay?: Relay;
  /** Handles whose Messages reach the session; any sender when empty or absent. */
  readonly senders?: readonly string[];
  /** Words for a voice note. Without it a voice note is named, not heard. */
  readonly transcribe?: Transcribe;
  /** Whether the session is between runs, so a Message can start one now. */
  readonly isIdle: () => boolean;
  /**
   * Where the chat of the last accepted Message is kept across restarts. A
   * run no Message started (a helper's result) sends its words there.
   */
  readonly lastChatFile?: string;
}

/**
 * The line sent when a run fails before it has words, so the person is not
 * left waiting. A run that ends with no words on its own is Pi staying
 * silent, and sends nothing.
 */
export const NO_ANSWER = "Sorry, something went wrong on my side.";

/** The image types a model takes as image content; any other file is named in words. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface SessionMedia {
  /** The bytes behind a media part. */
  download(part: MediaPartResponse): Promise<Buffer>;
  readonly transcribe?: Transcribe;
}

/**
 * One Message as the session's user message: its words with the same answer
 * rules the channel gives Pi, each photo as image content, each voice note as
 * its transcript, and any other file named. Null for a Message with nothing.
 */
export const sessionContent = async (data: MessageWebhookData, media: SessionMedia, replyLine = ""): Promise<SessionContent | null> => {
  const lines: string[] = [];
  const images: ImageBlock[] = [];
  for (const part of data.parts) {
    if (part.type !== "media") continue;
    const mime = String(part.mime_type ?? "").toLowerCase();
    const name = part.filename || "file";
    if (IMAGE_TYPES.has(mime)) {
      images.push({ type: "image", data: (await media.download(part)).toString("base64"), mimeType: mime });
      lines.push(`[photo: ${name}]`);
    } else if (mime.startsWith("audio/")) {
      const words = media.transcribe
        ? await media.transcribe(await media.download(part), name).catch(() => undefined)
        : undefined;
      lines.push(words ? `[voice note, transcribed]: ${words}` : `[voice note: ${name}, could not be transcribed]`);
    } else {
      lines.push(`[file: ${name} (${mime || "unknown type"}), not opened]`);
    }
  }
  const words = [wordsOf(data), lines.join("\n"), replyLine].filter(Boolean).join("\n\n");
  if (!words) return null;
  return [{ type: "text", text: piPrompt(words) }, ...images];
};

/**
 * What a finished run sends: the words of its last assistant message,
 * `NO_ANSWER` when that message ended in an error with no words, or undefined
 * for a run that chose to say nothing.
 */
export const lastAnswer = (messages: readonly unknown[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown; stopReason?: string } | undefined;
    if (message?.role !== "assistant") continue;
    const blocks = Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : [];
    const text = blocks.flatMap((block) => block?.type === "text" && block.text ? [block.text] : []).join("").trim();
    return text || (message.stopReason === "error" ? NO_ANSWER : undefined);
  }
  return undefined;
};

/** One-to-one Messages from a Handle, and only the listed Handles when there is a list. */
export const accepts = (event: RelayWebhookEvent, senders: readonly string[] = []): event is RelayWebhookEvent & { data: MessageWebhookData } => {
  if (event.event_type !== "message.received" || event.data.direction !== "inbound") return false;
  const data = event.data as MessageWebhookData;
  if (!data.sender_handle || data.chat.is_group) return false;
  if (!senders.length) return true;
  const handle = (value: string): string => value.replace(/^@/u, "").toLowerCase();
  return senders.some((sender) => handle(sender) === handle(data.sender_handle!.handle));
};

interface Turn { readonly data: MessageWebhookData; readonly key: string; readonly content: SessionContent }

/**
 * Relay inside the Pi session that loads it, the way pi-telegram holds a chat
 * in its own Pi process: each Message is one user message to that session,
 * and the session's answer goes back to the chat it came from once the run
 * has settled (after retries and queued follow-ups). Messages wait their turn,
 * so each gets its own answer; a run that ends with no words sends nothing.
 */
export class SessionChannel {
  readonly #pi: SessionPi;
  readonly #options: SessionChannelOptions;
  readonly #relay: Relay;
  readonly #queue: Turn[] = [];
  readonly #seen = new Set<string>();
  readonly #inflight = new Map<string, Promise<void>>();
  #pending: Turn | undefined;
  #ended: readonly unknown[] = [];
  // The role of the first message of the first run since the last settle:
  // "user" for a typed or Relay prompt, "custom" for an extension's message.
  #origin: string | null | undefined;
  #last: MessageWebhookData | undefined;
  constructor(pi: SessionPi, options: SessionChannelOptions) {
    if (!options.agentToken.trim()) throw new Error("Relay Agent Token is required");
    this.#pi = pi;
    this.#options = options;
    this.#relay = options.relay ?? new Relay({ apiKey: options.agentToken, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
    try {
      if (options.lastChatFile) this.#last = JSON.parse(readFileSync(options.lastChatFile, "utf8")) as MessageWebhookData;
    } catch { /* no chat yet */ }
  }
  run(signal?: AbortSignal): Promise<void> {
    return this.#relay.websocket.run({
      ...(signal ? { signal } : {}),
      onEvent: (event) => this.receive(event),
      // The session is the record; there is no inbox here to rebuild.
      onFullSync: async () => { console.error("Relay: FULL sync acknowledged; Messages sent while this session was away were not delivered."); },
      onError: (error: unknown) => { console.error(`Relay: ${error instanceof Error ? error.message : String(error)}`); },
    });
  }
  /** Takes one event: an accepted Message waits its turn in the session. */
  async receive(event: RelayWebhookEvent): Promise<void> {
    const inflight = this.#inflight.get(event.event_id);
    if (inflight) return inflight;
    if (this.#seen.has(event.event_id) || !accepts(event, this.#options.senders)) return;
    const handoff = (async () => {
      const content = await sessionContent(event.data, {
        download: (part) => this.#download(part),
        ...(this.#options.transcribe ? { transcribe: this.#options.transcribe } : {}),
      }, await repliedContext(this.#relay, event.data));
      this.#seen.add(event.event_id);
      this.#remember(event.data);
      if (!content) return;
      this.#queue.push({ data: event.data, key: `pi-${event.event_id}`, content });
      this.next();
    })();
    this.#inflight.set(event.event_id, handoff);
    try { await handoff; } finally { this.#inflight.delete(event.event_id); }
  }
  /** The chat whose Message the session is answering now, for the Relay tools. */
  get chatId(): string | undefined {
    return this.#pending?.data.chat.id;
  }
  /** Pi's `agent_end`: the messages of the run that just ended. */
  ended(messages: readonly unknown[]): void {
    if (!this.#pending && this.#origin === undefined) this.#origin = (messages[0] as { role?: string } | undefined)?.role ?? null;
    this.#ended = messages;
  }
  /**
   * Pi's `agent_settled`: the pending Message is answered and cleared, then
   * the next one starts. A run no Message started and no one typed (a
   * helper's result) sends its words to the last chat, as OpenClaw sends an
   * unprompted turn to the last route.
   */
  async settled(): Promise<void> {
    const turn = this.#pending;
    this.#pending = undefined;
    const answer = lastAnswer(this.#ended);
    const unprompted = !turn && this.#origin && this.#origin !== "user" ? this.#last : undefined;
    this.#ended = [];
    this.#origin = undefined;
    try {
      if (turn && answer) await sendAnswer(this.#relay, turn.data, turn.key, answer);
      else if (unprompted && answer) await sendAnswer(this.#relay, unprompted, `pi-unprompted-${Date.now()}`, answer);
    } catch (error) {
      console.error(`Relay: the answer was not sent: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.next();
    }
  }
  /**
   * Starts the next waiting Message when nothing of Relay's is running. When
   * the session is busy with a run Relay did not start, the Message steers
   * that run and its settled answer goes to the chat once.
   */
  next(): void {
    if (this.#pending || !this.#queue.length) return;
    const turn = this.#queue.shift()!;
    this.#pending = turn;
    if (!this.#options.isIdle()) {
      this.#pi.sendUserMessage(turn.content, { deliverAs: "steer" });
      return;
    }
    this.#ended = [];
    try {
      this.#pi.sendUserMessage(turn.content);
    } catch {
      // A run began between the check and the send; this one follows it.
      this.#pi.sendUserMessage(turn.content, { deliverAs: "followUp" });
    }
  }
  stop(): void {
    this.#queue.length = 0;
    this.#pending = undefined;
    this.#ended = [];
    this.#origin = undefined;
  }
  /** Keeps the chat of an accepted Message, across restarts, for unprompted answers. */
  #remember(data: MessageWebhookData): void {
    this.#last = { id: data.id, chat: { id: data.chat.id }, sender_handle: { handle: data.sender_handle?.handle }, parts: [] } as unknown as MessageWebhookData;
    try {
      if (this.#options.lastChatFile) writeFileSync(this.#options.lastChatFile, JSON.stringify(this.#last));
    } catch (error) {
      console.error(`Relay: the last chat was not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  #download(part: MediaPartResponse): Promise<Buffer> {
    return downloadMedia(this.#relay, part);
  }
}

/** The bytes behind a media part; an expired url is renewed once. */
export const downloadMedia = async (relay: Relay, part: MediaPartResponse): Promise<Buffer> => {
  let response = part.url ? await fetch(part.url).catch(() => undefined) : undefined;
  // A media url lasts 60 minutes; GET /v1/attachments/{id} makes a fresh one.
  if (!response?.ok && part.id) {
    const fresh = (await relay.attachments.retrieve(part.id)).download_url;
    if (fresh) response = await fetch(fresh);
  }
  if (!response?.ok) throw new Error(`Relay attachment download failed (${response?.status ?? "no url"})`);
  return Buffer.from(await response.arrayBuffer());
};
