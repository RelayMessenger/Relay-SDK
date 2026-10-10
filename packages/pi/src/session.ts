import { readFileSync, writeFileSync } from "node:fs";
import Relay, {
  type MediaPartResponse,
  type MessageWebhookData,
  type RelayWebhookEvent,
} from "@relaymessenger/sdk";
import { inboundText, repliedContext, replyTag, sendAnswer, sendToChat, typing, wordsOf } from "./index.js";
import { MESSAGE_TOOL } from "./tools.js";
import type { Transcribe } from "./voice.js";

export interface TextBlock { readonly type: "text"; readonly text: string }
export interface ImageBlock { readonly type: "image"; readonly data: string; readonly mimeType: string }
/** One Message as the session reads it: the words, then each photo as an image. */
export type SessionContent = (TextBlock | ImageBlock)[];

/** What the session is given in place of the Pi it would otherwise start. */
export interface SessionPi {
  sendUserMessage(content: SessionContent, options?: { deliverAs: "followUp" | "steer" }): void;
  sendMessage(message: {
    customType: string;
    content: SessionContent;
    display: boolean;
    details: { event_id: string; message_id: string; chat_id: string };
  }, options: { deliverAs: "steer" }): void;
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
 * One Message as the session's user message: its words and Relay message id,
 * each photo as image content, each voice note as
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
  return [{ type: "text", text: [inboundText(words, "", data), chatLine(data)].filter(Boolean).join("\n") }, ...images];
};

/**
 * The chat a Message came from and who sent it, as one line of data: one
 * session hears every chat, so each text names the chat a `message` with
 * `chat_id` answers it in.
 */
export const chatLine = (data: Pick<MessageWebhookData, "chat" | "sender_handle">): string => {
  const handle = data.sender_handle?.handle?.replace(/^@/u, "");
  return data.chat?.id ? `[Relay chat: ${data.chat.id}${handle ? `, from @${handle}` : ""}]` : "";
};

type RunMessage = { role?: string; content?: unknown; stopReason?: string; toolName?: string; details?: unknown; isError?: boolean; customType?: string };
const blocksOf = (message: RunMessage): { type?: string; text?: string; name?: string; arguments?: { action?: unknown } }[] =>
  Array.isArray(message.content) ? message.content as never : [];
const textOf = (message: RunMessage): string =>
  typeof message.content === "string" ? message.content : blocksOf(message).flatMap((block) => block?.type === "text" && block.text ? [block.text] : []).join("");

/**
 * What a finished run sends: the words of every assistant message in order,
 * `NO_ANSWER` when it has none and its last assistant message ended in an
 * error, or nothing for a run that chose to say nothing.
 */
export const runAnswers = (messages: readonly unknown[]): string[] => {
  const assistants = (messages as RunMessage[]).filter((message) => message?.role === "assistant");
  const answers = assistants.map((message) => textOf(message).trim()).filter(Boolean);
  if (answers.length) return answers;
  return assistants.at(-1)?.stopReason === "error" ? [NO_ANSWER] : [];
};

/**
 * The chats the run texted itself with `message` send, so its final words
 * are not sent there again (OpenClaw didSendViaMessagingTool). Only a send
 * that went out counts: the tool marks it with `details.sent` and the chat
 * with `details.chat_id`; a send that names no chat is `CURRENT_CHAT`.
 */
export const textedChats = (messages: readonly unknown[]): Set<string> =>
  new Set((messages as RunMessage[]).flatMap((message) => {
    if (message?.role !== "toolResult" || message.toolName !== MESSAGE_TOOL || message.isError) return [];
    const details = message.details as { sent?: unknown; chat_id?: unknown } | undefined;
    if (details?.sent !== true) return [];
    return [typeof details.chat_id === "string" && details.chat_id ? details.chat_id : CURRENT_CHAT];
  }));
/** A `message` send that named no chat: the chat being answered. */
export const CURRENT_CHAT = "";
/** Whether the run texted any chat itself with `message` send. */
export const textedWithMessage = (messages: readonly unknown[]): boolean => textedChats(messages).size > 0;

/** pi-subagents' tool, whose result carries `details.asyncId` when it started a background run (pi-subagents src/runs/background/async-execution.js). */
export const SUBAGENT_TOOL = "subagent";
/** The custom message pi-subagents sends when a background run finishes (src/runs/background/notify.js). */
export const SUBAGENT_NOTICE = "subagent-notify";

/** The background runs a run started: each pi-subagents launch's id and directory. */
export const backgroundLaunches = (messages: readonly unknown[]): { id: string; dir?: string }[] =>
  (messages as RunMessage[]).flatMap((message) => {
    if (message?.role !== "toolResult" || message.toolName !== SUBAGENT_TOOL || message.isError) return [];
    const details = message.details as { asyncId?: unknown; asyncDir?: unknown } | undefined;
    if (typeof details?.asyncId !== "string" || !details.asyncId) return [];
    return [{ id: details.asyncId, ...(typeof details.asyncDir === "string" && details.asyncDir ? { dir: details.asyncDir } : {}) }];
  });

/**
 * One answer as the bubbles a person would send: split at blank lines
 * (OpenClaw chunkMode "newline"), a fenced block kept whole and under the
 * words before it, so buttons and cards stay with their text.
 */
export const bubbles = (answer: string): string[] => {
  const out: string[] = [];
  let current: string[] = [];
  // The open fence's character and length: CommonMark closes it with the same
  // character, at least as many, and nothing after but spaces.
  let fence: { char: string; length: number } | undefined;
  let fencedBlock = false;
  const flush = (): void => {
    const text = current.join("\n").trim();
    current = [];
    const block = fencedBlock;
    fencedBlock = false;
    if (!text) return;
    if (block && out.length) out[out.length - 1] += `\n\n${text}`;
    else out.push(text);
  };
  for (const line of answer.replace(/\r\n?/gu, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!fence && marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      flush();
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      fencedBlock = true;
      current.push(line);
      continue;
    }
    if (fence) {
      current.push(line);
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined;
        flush();
      }
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return out;
};

/**
 * One answer as bubbles, its reply tag read from the whole answer first and
 * carried by the first bubble, so a tag on a line of its own still threads.
 */
export const taggedBubbles = (answer: string): string[] => {
  const tagged = replyTag(answer);
  const parts = bubbles(tagged.answer);
  if (tagged.replyTo === undefined || !parts.length) return parts;
  parts[0] = `${tagged.replyTo === "current" ? "[[reply_to_current]]" : `[[reply_to:${tagged.replyTo}]]`} ${parts[0]}`;
  return parts;
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

interface Turn { readonly data: MessageWebhookData; readonly eventId: string; readonly key: string; readonly content: SessionContent }

/**
 * Relay inside the Pi session that loads it, the way pi-telegram holds a chat
 * in its own Pi process: each Message is one user message to that session,
 * and the session's answer goes back to the chat it came from once the run
 * has settled (after retries and queued follow-ups). A Message from any chat
 * that arrives while a run is going steers that run. The run's words go to
 * the chat whose Message started it; a steered Message from another chat is
 * answered by `message` with its `chat_id`, and one the run never texted runs
 * again as a turn of its own. A run that ends with no words sends nothing.
 */
export class SessionChannel {
  readonly #pi: SessionPi;
  readonly #options: SessionChannelOptions;
  readonly #relay: Relay;
  readonly #queue: Turn[] = [];
  readonly #seen = new Set<string>();
  readonly #inflight = new Map<string, Promise<void>>();
  #pending: Turn | undefined;
  #running = false;
  #idleWake: ReturnType<typeof setTimeout> | undefined;
  // Messages from any chat steered into the pending turn's run.
  readonly #steered: Turn[] = [];
  #ended: readonly unknown[] = [];
  // The role of the first message of the first run since the last settle:
  // "user" for a typed or Relay prompt, "custom" for an extension's message.
  #origin: string | null | undefined;
  #last: MessageWebhookData | undefined;
  // The chats a run since the last settle texted itself with `message`.
  #texted = new Set<string>();
  // The newest Message of each chat, for a tool that names another chat.
  readonly #latest = new Map<string, string>();
  // Background runs a Message's turn started, so each result threads to that Message.
  readonly #background: { id: string; dir?: string; data: MessageWebhookData }[] = [];
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
      this.#queue.push({ data: event.data, eventId: event.event_id, key: `pi-${event.event_id}`, content });
      this.next();
    })();
    this.#inflight.set(event.event_id, handoff);
    try { await handoff; } finally { this.#inflight.delete(event.event_id); }
  }
  /**
   * The chat the Relay tools act on: the one whose Message the session is
   * answering, else (a background result's run) the chat of the Message whose
   * turn started the newest waiting background run, else the last chat.
   */
  get chatId(): string | undefined {
    return (this.#pending?.data ?? this.#background.at(-1)?.data ?? this.#last)?.chat.id;
  }
  /** The Message the tools react and thread to, chosen as `chatId` is. */
  get messageId(): string | undefined {
    return (this.#pending?.data ?? this.#background.at(-1)?.data ?? this.#last)?.id;
  }
  /** The newest Message of a chat the session has heard from. */
  latestIn(chatId: string): string | undefined {
    return this.#latest.get(chatId);
  }
  /** Pi's agent_start, distinct from being busy with compaction or a tree summary. */
  started(): void {
    this.#running = true;
    this.next();
  }
  /** Pi's `agent_end`: the messages of the run that just ended. */
  ended(messages: readonly unknown[]): void {
    if (!this.#pending && this.#origin === undefined) this.#origin = (messages[0] as { role?: string } | undefined)?.role ?? null;
    // A message queued as a run ends gets a continuation with its own agent_end before the settle.
    this.#ended = [...this.#ended, ...messages];
    for (const chat of textedChats(messages)) this.#texted.add(chat);
    const data = this.#pending?.data;
    if (data) for (const launch of backgroundLaunches(messages)) this.#background.push({ ...launch, data });
  }
  /**
   * Pi's `agent_settled`: the pending Message is answered and cleared, then
   * the next one starts. Every assistant text of the run goes out as bubbles
   * to the chat whose Message started the run (OpenClaw answers on the route
   * a run came from), unless the run texted that chat itself with `message`.
   * A Message steered in from another chat that the run never texted runs
   * again as a turn of its own, so its answer reaches its own chat. A run no Message
   * started and no one typed (a helper's result) sends its words as a reply to
   * the Message whose turn started that background run, or else to the last
   * chat, as OpenClaw sends an unprompted turn to the last route.
   */
  async settled(): Promise<void> {
    const turn = this.#pending;
    this.#running = false;
    this.#pending = undefined;
    // Custom steers enter Pi's queue synchronously; they cannot become a
    // delayed prompt while an input hook runs. No whole-text matching is needed.
    const steers = this.#steered.splice(0);
    const unprompted = !turn && this.#origin && this.#origin !== "user";
    const started = unprompted ? this.#startedBy(this.#ended[0]) : undefined;
    const target = turn?.data.chat.id ?? started?.data.chat.id ?? (unprompted ? this.#last?.chat.id : undefined);
    const texted = this.#texted;
    const answered = (chat: string | undefined): boolean => texted.has(chat ?? CURRENT_CHAT) || (chat === target && texted.has(CURRENT_CHAT));
    const answers = answered(target) ? [] : runAnswers(this.#ended).flatMap(taggedBubbles);
    // Steers from another chat that this run took in and never texted: each runs again, in order, ahead of the queue.
    const unanswered = steers.filter((steer) => steer.data.chat.id !== target && !answered(steer.data.chat.id));
    this.#queue.unshift(...unanswered);
    this.#ended = [];
    this.#origin = undefined;
    this.#texted = new Set();
    try {
      for (const [index, bubble] of answers.entries()) {
        if (turn) await sendAnswer(this.#relay, turn.data, index ? `${turn.key}-p${index}` : turn.key, bubble);
        else if (started) await sendToChat(this.#relay, started.data.chat.id, `pi-background-${started.id}-${index}`, bubble, started.data.id, started.data.id);
        else if (unprompted && this.#last) await sendAnswer(this.#relay, this.#last, `pi-unprompted-${Date.now()}-${index}`, bubble);
      }
    } catch (error) {
      console.error(`Relay: the answer was not sent: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (turn) await typing(this.#relay, turn.data.chat.id, false);
      for (const chat of new Set(steers.map((steer) => steer.data.chat.id))) if (chat !== turn?.data.chat.id) await typing(this.#relay, chat, false);
      this.next();
    }
  }
  /**
   * The Message whose turn started the background run this notice reports,
   * found by the run's id or directory in the notice; the one waiting run when
   * a pi-subagents notice names none. It is forgotten once found.
   */
  #startedBy(first: unknown): { id: string; data: MessageWebhookData } | undefined {
    const notice = first as RunMessage | undefined;
    if (notice?.role !== "custom") return undefined;
    const words = textOf(notice);
    const named = this.#background.filter((launch) => words.includes(launch.id) || (launch.dir !== undefined && words.includes(launch.dir)));
    const found = named.length ? named : notice.customType === SUBAGENT_NOTICE && this.#background.length === 1 ? [...this.#background] : [];
    for (const launch of found) this.#background.splice(this.#background.indexOf(launch), 1);
    return found[0];
  }
  /**
   * Starts the next waiting Message when nothing of Relay's is running. When
   * the session is busy with a run Relay did not start, the Message steers
   * that run and its settled answer goes to the chat once. A Message from any
   * chat steers a run Relay started too (Pi delivers it after the current
   * tool call): it names its chat, and `settled` sees that it is answered.
   */
  next(): void {
    if (this.#idleWake) clearTimeout(this.#idleWake);
    this.#idleWake = undefined;
    if (!this.#queue.length) return;
    const idle = this.#options.isIdle();
    // Pi clears its active flag before awaiting all settled handlers. Until
    // our handler runs, a new Message must wait rather than merely append.
    if (this.#running && idle) return;
    if (!this.#running && !idle) {
      // ExtensionContext has no waitForIdle, and cancelled tree navigation
      // has no completion event. Wait on runtime state, not event timing.
      this.#idleWake = setTimeout(() => this.next(), 25);
      this.#idleWake.unref();
      return;
    }
    while (this.#pending && this.#queue.length && this.#running) {
      const turn = this.#queue.shift()!;
      this.#steered.push(turn);
      if (turn.data.chat.id !== this.#pending.data.chat.id) void typing(this.#relay, turn.data.chat.id, true);
      this.#steer(turn);
    }
    if (this.#pending || !this.#queue.length) return;
    const turn = this.#queue.shift()!;
    this.#pending = turn;
    // The person sees Pi typing while it works, steered or not; settled() stops it once the answer is sent.
    void typing(this.#relay, turn.data.chat.id, true);
    if (this.#running) {
      this.#steer(turn);
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
    if (this.#idleWake) clearTimeout(this.#idleWake);
    this.#idleWake = undefined;
    this.#queue.length = 0;
    this.#pending = undefined;
    this.#running = false;
    this.#steered.length = 0;
    this.#ended = [];
    this.#origin = undefined;
    this.#texted = new Set();
    this.#background.length = 0;
  }
  #steer(turn: Turn): void {
    this.#pi.sendMessage({
      customType: "relay-inbound",
      content: turn.content,
      display: true,
      details: { event_id: turn.eventId, message_id: turn.data.id, chat_id: turn.data.chat.id },
    }, { deliverAs: "steer" });
  }
  /** Keeps the chat of an accepted Message, across restarts, for unprompted answers. */
  #remember(data: MessageWebhookData): void {
    this.#latest.set(data.chat.id, data.id);
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
