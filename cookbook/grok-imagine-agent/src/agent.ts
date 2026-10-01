import type {
  AttachmentCreateParams,
  Chat,
  Message,
  AttachmentCreateResponse,
  ContactCardRetrieveResponse,
  ContactCardUpdateParams,
  MessageSendParams,
  MessageSendResponse,
} from "@relaymessenger/sdk";

import type { ProgressStore } from "./store.js";
import { outputText, XaiError, type FunctionTool, type Media, type ResponseItem, type Xai } from "./xai.js";

/** The fields this recipe reads from `contactCard.update`. */
export interface ProfileCard {
  handle: string;
  image_url: string | null;
}

/**
 * The character, described the same way in every prompt, so every picture
 * and video looks like the reference picture.
 */
export const CHARACTER =
  "Diego, a chubby brown cartoon squirrel with big round brown eyes, a cream muzzle and cheeks, "
  + "tufted ears and a bushy tail, wearing a hoodie with a maize-yellow body and navy-blue sleeves "
  + "and hood, drawn in a clean, flat cartoon style";

const SAME_LOOK =
  "Keep his face, fur colors, hoodie and art style exactly as in the reference picture. No text, no logos.";

export const PERSONA =
  "You are Diego, a chubby, fast-talking squirrel who lives on the University of Michigan Diag. "
  + "You text like a friend: one or two short sentences, no lists. You love acorns, campus gossip "
  + "and helping students find their way. You can make pictures of yourself with send_picture "
  + "(selfies, memes, you somewhere on campus) and short videos with send_video. Send one when it "
  + "makes the chat more fun or when someone asks; never describe a picture you did not send. "
  + "In a group chat, answer only when the message is for you or you have something to add; "
  + "otherwise call stay_silent.";

export const TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "send_picture",
    description: "Make a picture of yourself (a selfie, a meme, you somewhere) and send it into the chat.",
    parameters: {
      type: "object",
      properties: {
        scene: { type: "string", description: "What the picture shows, in one sentence." },
        caption: { type: "string", description: "Meme text drawn on the picture, if it is a meme." },
      },
      required: ["scene"],
    },
  },
  {
    type: "function",
    name: "send_video",
    description: "Make a short video of yourself (about 6 seconds) and send it into the chat. Takes about a minute.",
    parameters: {
      type: "object",
      properties: {
        scene: { type: "string", description: "Where you are, in one sentence." },
        action: { type: "string", description: "What you do in the video, in one sentence." },
      },
      required: ["scene", "action"],
    },
  },
  {
    type: "function",
    name: "stay_silent",
    description: "Send nothing for this message. Use it in a group chat when the message is not for you.",
    parameters: { type: "object", properties: {} },
  },
];

/**
 * A runaway-loop limit, the `max_turns` of agent SDKs: Grok gets at most this
 * many steps per incoming message, then the turn ends.
 */
export const MAX_STEPS = 4;

/**
 * Grok sees at most this many recent items of a chat, cut at the start of a
 * person's message so a tool call never loses its result. This is the
 * trimming pattern of agent SDK sessions: older turns stay in the store and
 * are left out of the request.
 */
export const HISTORY_WINDOW = 40;

/**
 * An event is given up after this many lasting refusals, one per delivery
 * (xAI or Relay answering 4xx other than 408 or 429, or any other failure
 * that is not passing). Giving up means a refusal that repeats never blocks
 * the chat: the event is acknowledged and the next message goes through.
 */
export const MAX_REFUSALS = 3;

/**
 * A passing failure (xAI or Relay not reached, or answering 408, 429 or 5xx)
 * is retried in place, never counted as a refusal: after Retry-After when the
 * service sent one, else after 1, 2, 4, ... seconds up to RETRY_MAX_WAIT_MS.
 * Once the waits of one delivery would pass RETRY_LIMIT_MS, the event is left
 * to Relay to deliver again.
 */
export const RETRY_LIMIT_MS = 2 * 60_000;
export const RETRY_MAX_WAIT_MS = 30_000;

/** A video still pending this long after its request is reported to Grok as failed. */
export const VIDEO_DEADLINE_MS = 10 * 60_000;

function isPersonTurn(item: ResponseItem): boolean {
  return "role" in item && !("type" in item) && item.role === "user";
}

/**
 * The words Grok reads for one Relay Message: its text and links, prefixed in
 * a group chat with who said them. Null for a Message with nothing to read.
 */
export function wordsOf(
  parts: readonly { type: string; value?: unknown }[],
  speaker: string,
  inGroup: boolean,
): string | null {
  const words = parts
    .map((part) => (part.type === "text" || part.type === "link" ? String(part.value ?? "") : ""))
    .join("\n")
    .trim();
  if (!words) return null;
  return inGroup ? `${speaker} (in a group chat): ${words}` : words;
}

export function recentWindow(items: ResponseItem[], limit = HISTORY_WINDOW): ResponseItem[] {
  if (items.length <= limit) return items;
  let start = items.length - limit;
  while (start < items.length && !isPersonTurn(items[start]!)) start += 1;
  return [
    { role: "developer", content: "Earlier messages in this chat are not shown." },
    ...items.slice(start),
  ];
}

export function picturePrompt(scene: string, caption?: string): string {
  const meme = caption ? ` Bold white meme text with a black outline reads: "${caption}".` : "";
  return `${CHARACTER}. ${scene}.${meme} ${SAME_LOOK}`;
}

/** The Relay calls this agent makes. */
export interface RelayClient {
  attachments: {
    create(body: AttachmentCreateParams): Promise<AttachmentCreateResponse>;
    upload(allocation: AttachmentCreateResponse, data: BodyInit): Promise<void>;
  };
  chats: {
    messages: {
      send(chatId: string, body: MessageSendParams): Promise<MessageSendResponse>;
      list(chatId: string, query?: { limit?: number }): Promise<AsyncIterable<Message>>;
    };
    listChats(query?: { limit?: number }): Promise<AsyncIterable<Chat>>;
  };
  contactCard: {
    retrieve(): Promise<ContactCardRetrieveResponse>;
    update(params: ContactCardUpdateParams): Promise<ProfileCard>;
  };
}

/** Uploads one file through the Attachments API and returns its id. */
export async function upload(relay: RelayClient, media: Media): Promise<string> {
  const allocation = await relay.attachments.create({
    filename: media.filename,
    content_type: media.contentType,
    size_bytes: media.bytes.byteLength,
  });
  await relay.attachments.upload(allocation, Uint8Array.from(media.bytes).buffer);
  return allocation.attachment_id;
}

/** Makes a profile picture from the reference and sets it on the agent's Contact Card. */
export async function setProfilePicture(
  relay: RelayClient,
  xai: Xai,
  reference: Media,
): Promise<ProfileCard> {
  const picture = await xai.picture(
    reference,
    picturePrompt("A square profile picture: his head and shoulders, centered, smiling at the camera, on a plain maize-yellow background"),
  );
  const [card] = (await relay.contactCard.retrieve()).contact_cards;
  if (!card?.handle) throw new Error("The agent has no Contact Card to update.");
  return relay.contactCard.update({ handle: card.handle, attachment_id: await upload(relay, picture) });
}

export interface Incoming {
  eventId: string;
  chatId: string;
  /** The Relay Message being answered; one Message is answered once. */
  messageId?: string;
  /** The person's words; in a group chat, prefixed with who said them. */
  text: string;
}

export interface AgentDependencies {
  relay: RelayClient;
  xai: Xai;
  store: ProgressStore;
  reference: Media;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait before retrying a passing failure, or undefined for a
 * lasting one. Relay's SDK errors carry `retryable` and `retryAfter`
 * (seconds); this recipe's XaiError carries `passing` and `retryAfterMs`.
 */
export function retryWait(error: unknown, attempt: number): number | undefined {
  const backoff = Math.min(1_000 * 2 ** attempt, RETRY_MAX_WAIT_MS);
  if (error instanceof XaiError) return error.passing ? error.retryAfterMs ?? backoff : undefined;
  if (error instanceof Error && "retryable" in error && typeof error.retryable === "boolean" && "status" in error) {
    if (!error.retryable) return undefined;
    const seconds = "retryAfter" in error ? error.retryAfter : undefined;
    return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1_000 : backoff;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers one incoming message, and resumes it after a failure. Every
 * finished step is in the store before its side effects run: a redelivered
 * event never adds the person's words twice, never asks Grok again for a
 * step it already answered, never pays for a picture or video it already
 * has, and re-sends a Message only with the same idempotency key and body.
 */
export async function answer(deps: AgentDependencies, incoming: Incoming): Promise<void> {
  const { store, xai } = deps;
  const { eventId, chatId } = incoming;
  if (!store.begin(eventId, chatId, { role: "user", content: incoming.text }, incoming.messageId)) return;
  if (store.event(eventId)?.done !== false) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run(deps, incoming);
      return;
    } catch (error) {
      const wait = retryWait(error, attempt);
      if (wait !== undefined && waited + wait <= RETRY_LIMIT_MS) {
        console.error(JSON.stringify({ event: "retrying", event_id: eventId, wait_ms: wait, error: messageOf(error) }));
        await sleep(wait);
        waited += wait;
        continue;
      }
      closeOpenCalls(store, incoming, error);
      // Still passing after RETRY_LIMIT_MS: Relay delivers the event again; nothing is counted.
      if (wait !== undefined) throw error;
      const refusals = store.refused(eventId);
      if (refusals < MAX_REFUSALS) throw error;
      store.fail(eventId);
      console.error(JSON.stringify({ event: "event_failed", event_id: eventId, refusals, error: messageOf(error) }));
      await sayItFailed(deps, incoming);
      return;
    }
  }
}

/**
 * Gives every function call of this event still in the chat an output: the
 * error. The Responses API pairs each `function_call` with a
 * `function_call_output`; a call left without one would go to Grok with every
 * later message of the chat.
 */
function closeOpenCalls(store: ProgressStore, incoming: Incoming, error: unknown): void {
  const items = store.items(incoming.chatId);
  const answered = answeredCalls(items);
  const ours = new Set(store.steps(incoming.eventId).flatMap((output) => functionCalls(output).map((call) => call.call_id)));
  const open = functionCalls(items).filter((call) => ours.has(call.call_id) && !answered.has(call.call_id));
  if (open.length === 0) return;
  store.append(incoming.chatId, open.map((call) => ({
    type: "function_call_output",
    call_id: call.call_id,
    output: `It did not work: ${messageOf(error)}`,
  })));
}

/**
 * After giving up, Grok tells the person in its own words that it could not
 * do that. If Grok cannot answer either, the agent stays silent.
 */
async function sayItFailed(deps: AgentDependencies, incoming: Incoming): Promise<void> {
  try {
    const cue: ResponseItem = {
      role: "developer",
      content: "You could not answer the person's last message because of an error. Tell them briefly that you couldn't do that.",
    };
    const output = await deps.xai.respond(PERSONA, [...recentWindow(deps.store.items(incoming.chatId)), cue], []);
    const text = outputText(output);
    if (!text) return;
    await send(deps, incoming.chatId, `${incoming.eventId}:failed`, [{ type: "text", value: text }]);
    deps.store.append(incoming.chatId, [{ role: "assistant", content: text }]);
  } catch (error) {
    console.error(JSON.stringify({ event: "failure_notice_failed", event_id: incoming.eventId, error: messageOf(error) }));
  }
}

async function run(deps: AgentDependencies, incoming: Incoming): Promise<void> {
  const { store, xai } = deps;
  const { eventId, chatId } = incoming;
  for (;;) {
    const steps = store.steps(eventId);
    // Finish the side effects of every recorded step; each is skipped once done.
    for (const [index, output] of steps.entries()) {
      const text = outputText(output);
      if (text) await send(deps, chatId, `${eventId}:${index}:text`, [{ type: "text", value: text }]);
      const answered = answeredCalls(store.items(chatId));
      for (const call of functionCalls(output).filter((call) => !answered.has(call.call_id))) {
        const result = await runTool(deps, incoming, call);
        store.append(chatId, [{ type: "function_call_output", call_id: call.call_id, output: result }]);
      }
    }
    const last = steps.at(-1);
    const lastCalls = last ? functionCalls(last) : [];
    const silent = lastCalls.length > 0 && lastCalls.every((call) => call.name === "stay_silent");
    if ((last && lastCalls.length === 0) || silent || steps.length >= MAX_STEPS) {
      store.finish(eventId);
      return;
    }
    store.step(eventId, chatId, await xai.respond(PERSONA, recentWindow(store.items(chatId)), TOOLS));
  }
}

type FunctionCall = Extract<ResponseItem, { type: "function_call" }>;

function functionCalls(output: ResponseItem[]): FunctionCall[] {
  return output.filter((item): item is FunctionCall => "type" in item && item.type === "function_call");
}

function answeredCalls(items: ResponseItem[]): Set<string> {
  return new Set(items.flatMap((item) => ("type" in item && item.type === "function_call_output" ? [item.call_id] : [])));
}

/**
 * Runs one tool. A lasting failure becomes the tool's result, so the call
 * always gets an output and Grok can answer in words; a passing failure
 * throws, so `answer` retries and the tool resumes here.
 */
async function runTool(deps: AgentDependencies, incoming: Incoming, call: FunctionCall): Promise<string> {
  try {
    return await useTool(deps, incoming, call);
  } catch (error) {
    if (retryWait(error, 0) !== undefined) throw error;
    const result = `It did not work: ${messageOf(error)}`;
    console.error(JSON.stringify({ event: "tool_failed", tool: call.name, error: result }));
    return result;
  }
}

async function useTool(deps: AgentDependencies, incoming: Incoming, call: FunctionCall): Promise<string> {
  if (call.name === "stay_silent") return "You sent nothing.";
  let args: Record<string, string>;
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, string>;
  } catch {
    return `Your arguments were not valid JSON: ${call.arguments}. Call ${call.name} again with a JSON object.`;
  }
  const key = `${incoming.eventId}:${call.call_id}`;
  let attachmentId = deps.store.upload(key);
  if (!attachmentId) {
    const still = await made(deps, `${key}:still`, () =>
      deps.xai.picture(deps.reference, picturePrompt(args.scene ?? "", args.caption)));
    const media = call.name === "send_video"
      ? await made(deps, `${key}:video`, () => video(deps, key, still, `${args.action ?? ""} Static camera. ${SAME_LOOK}`))
      : still;
    attachmentId = await upload(deps.relay, media);
    deps.store.saveUpload(key, attachmentId);
  }
  await send(deps, incoming.chatId, key, [{ type: "media", attachment_id: attachmentId }]);
  return `Sent the ${call.name === "send_video" ? "video" : "picture"}.`;
}

/** A video, requested once: the request id is saved before polling, so a restart polls it again. */
async function video(deps: AgentDependencies, key: string, still: Media, prompt: string): Promise<Media> {
  let request = deps.store.video(key);
  if (!request) {
    const requestId = await deps.xai.startVideo(still, prompt);
    request = { requestId, deadline: Date.now() + VIDEO_DEADLINE_MS };
    deps.store.saveVideo(key, request.requestId, request.deadline);
  }
  return deps.xai.videoResult(request.requestId, request.deadline);
}

/**
 * FULL sync: Relay could not replay every event, so messages may have been
 * missed. Rebuild each chat's history from Relay, then answer the newest
 * person's message in each chat that came after the agent's last message and
 * that no event has taken. Runs before the sync is acknowledged.
 */
export async function recoverChats(deps: AgentDependencies, describe: (message: Message, chat: Chat) => string | null): Promise<void> {
  for await (const chat of await deps.relay.chats.listChats({ limit: 100 })) {
    const messages: Message[] = [];
    for await (const message of await deps.relay.chats.messages.list(chat.id, { limit: 100 })) messages.push(message);
    messages.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const items: ResponseItem[] = [];
    for (const message of messages) {
      const text = describe(message, chat);
      if (text === null) continue;
      items.push(message.is_from_me ? { role: "assistant", content: text } : { role: "user", content: text });
    }
    const last = messages.at(-1);
    const missed = last && !last.is_from_me && describe(last, chat) !== null && !deps.store.hasMessage(last.id)
      ? last
      : undefined;
    // The missed message is added by its own event below, not by the snapshot.
    deps.store.replaceChat(chat.id, missed ? items.slice(0, -1) : items);
    if (missed) {
      await answer(deps, {
        eventId: `full-sync:${missed.id}`,
        chatId: chat.id,
        messageId: missed.id,
        text: describe(missed, chat)!,
      });
    }
  }
}

/** Grok Imagine output, made once and kept, so a retry never pays for it again. */
async function made(deps: AgentDependencies, key: string, make: () => Promise<Media>): Promise<Media> {
  const kept = deps.store.media(key);
  if (kept) return kept;
  const media = await make();
  deps.store.saveMedia(key, media);
  return media;
}

async function send(
  deps: AgentDependencies,
  chatId: string,
  key: string,
  parts: MessageSendParams["message"]["parts"],
): Promise<void> {
  if (deps.store.sent(key)) return;
  const result = await deps.relay.chats.messages.send(chatId, { message: { parts, idempotency_key: key } });
  deps.store.saveSent(key, result.message.id);
}
