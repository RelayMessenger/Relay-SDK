import type {
  AttachmentCreateParams,
  AttachmentCreateResponse,
  ContactCardRetrieveResponse,
  ContactCardUpdateParams,
  MessageSendParams,
  MessageSendResponse,
} from "@relaymessenger/sdk";

import type { ChatMessage, Media, ToolDefinition, Xai } from "./xai.js";

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
  + "makes the chat more fun or when someone asks; never describe a picture you did not send.";

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
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
  },
  {
    type: "function",
    function: {
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
  },
];

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

/**
 * Answers one incoming message. Grok reads the chat so far and either
 * replies in text or calls a tool; a tool makes the picture or video with
 * Grok Imagine and sends it into the chat, then Grok continues. Returns the
 * ids of the Messages it sent. `key` makes every send idempotent, so a
 * redelivered event re-sends nothing new.
 */
export async function answer(
  relay: RelayClient,
  xai: Xai,
  reference: Media,
  chatId: string,
  history: ChatMessage[],
  key: string,
): Promise<string[]> {
  const sent: string[] = [];
  const send = async (parts: MessageSendParams["message"]["parts"]): Promise<void> => {
    const result = await relay.chats.messages.send(chatId, {
      message: { parts, idempotency_key: `${key}:${sent.length}` },
    });
    sent.push(result.message.id);
  };
  const messages: ChatMessage[] = [{ role: "system", content: PERSONA }, ...history];
  for (let step = 0; step < 4; step++) {
    const reply = await xai.chat(messages, TOOLS);
    messages.push(reply);
    if (!reply.tool_calls?.length) {
      if (reply.content?.trim()) await send([{ type: "text", value: reply.content.trim() }]);
      break;
    }
    for (const call of reply.tool_calls) {
      const args = JSON.parse(call.function.arguments) as Record<string, string>;
      let result: string;
      try {
        const still = await xai.picture(reference, picturePrompt(args.scene ?? "", args.caption));
        const media = call.function.name === "send_video"
          ? await xai.video(still, `${args.action ?? ""} Static camera. ${SAME_LOOK}`)
          : still;
        await send([{ type: "media", attachment_id: await upload(relay, media) }]);
        result = `Sent the ${call.function.name === "send_video" ? "video" : "picture"}.`;
      } catch (error) {
        result = `It did not work: ${error instanceof Error ? error.message : String(error)}`;
        console.error(JSON.stringify({ event: "tool_failed", tool: call.function.name, error: result }));
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  history.splice(0, history.length, ...messages.slice(1));
  return sent;
}
