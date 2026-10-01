import type {
  AttachmentCreateParams,
  AttachmentCreateResponse,
  ContactCardRetrieveResponse,
  ContactCardUpdateParams,
  MessageSendParams,
  MessageSendResponse,
} from "@relaymessenger/sdk";

import type { ProgressStore } from "./store.js";
import { outputText, type FunctionTool, type Media, type ResponseItem, type Xai } from "./xai.js";

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
    messages: { send(chatId: string, body: MessageSendParams): Promise<MessageSendResponse> };
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
  /** The person's words; in a group chat, prefixed with who said them. */
  text: string;
}

export interface AgentDependencies {
  relay: RelayClient;
  xai: Xai;
  store: ProgressStore;
  reference: Media;
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
  store.begin(eventId, chatId, { role: "user", content: incoming.text });
  if (store.event(eventId)?.done !== false) return;

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
    store.step(eventId, chatId, await xai.respond(PERSONA, store.items(chatId), TOOLS));
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
 * Runs one tool. A Grok Imagine failure becomes the tool's result, so Grok
 * can answer in words; a Relay failure throws, so the event is redelivered
 * and resumes here.
 */
async function runTool(deps: AgentDependencies, incoming: Incoming, call: FunctionCall): Promise<string> {
  if (call.name === "stay_silent") return "You sent nothing.";
  const args = JSON.parse(call.arguments || "{}") as Record<string, string>;
  const key = `${incoming.eventId}:${call.call_id}`;
  let attachmentId = deps.store.upload(key);
  if (!attachmentId) {
    let media: Media;
    try {
      const still = await made(deps, `${key}:still`, () =>
        deps.xai.picture(deps.reference, picturePrompt(args.scene ?? "", args.caption)));
      media = call.name === "send_video"
        ? await made(deps, `${key}:video`, () => deps.xai.video(still, `${args.action ?? ""} Static camera. ${SAME_LOOK}`))
        : still;
    } catch (error) {
      const result = `It did not work: ${error instanceof Error ? error.message : String(error)}`;
      console.error(JSON.stringify({ event: "tool_failed", tool: call.name, error: result }));
      return result;
    }
    attachmentId = await upload(deps.relay, media);
    deps.store.saveUpload(key, attachmentId);
  }
  await send(deps, incoming.chatId, key, [{ type: "media", attachment_id: attachmentId }]);
  return `Sent the ${call.name === "send_video" ? "video" : "picture"}.`;
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
