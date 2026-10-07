import { llm } from "@livekit/agents";
import type Relay from "@relaymessenger/sdk";
import {
  BUTTONS_GUIDANCE,
  LINK_URL_MAX_LENGTH,
  SELECTION_GUIDANCE,
  buttonsPart,
  locationContext,
  partsWithButtons,
  partsWithSelection,
  selectionPart,
  selectionReply,
  selectionReplyContext,
  standaloneLink,
  type Message,
  type MessagePart,
  type PlacePart,
} from "@relaymessenger/sdk";

/** The part of the Relay client the chat tools and context use. */
export type RelayChatClient = Pick<Relay, "chats">;

/** What a send tool hands back to the model. */
export interface RelaySentResult {
  status: "sent";
  message_id: string;
}

/** What `read_location` hands back to the model. */
export type RelayLocationReadResult =
  | { status: "not_sharing" }
  | {
    status: "sharing";
    locations: Array<{ handle: string; latitude: number; longitude: number; updated_at: string }>;
  };

const TEXT = {
  type: "string",
  description: "Optional words sent as a normal message bubble above the card.",
} as const;

/** The JSON Schema form of an `llm.tool` input schema. */
type ToolSchema = NonNullable<Parameters<typeof llm.tool>[0]["parameters"]>;

const strict = (properties: Record<string, unknown>, required: string[] = []): ToolSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
}) as ToolSchema;

const fail = (reason: string): never => {
  throw new llm.ToolError(reason);
};

const optionalText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Relay chat tools for a LiveKit Agents voice agent: text the person in the
 * Call's chat during the Call, with the same parts Relay's text agents send.
 * The keys are the model-visible tool names; pass the record as an Agent's
 * `tools`, alone or spread beside your own.
 */
export function relayChatTools(relay: RelayChatClient, chatId: string) {
  const send = async (parts: MessagePart[]): Promise<RelaySentResult> => {
    const response = await relay.chats.messages.send(chatId, { message: { parts } });
    return { status: "sent", message_id: response.message.id };
  };

  return {
    send_message: llm.tool({
      description: "Send a text message to the person in this Relay chat. Use it for anything they should keep "
        + "after the call: an address, a number, a list, a summary.",
      parameters: strict({ text: { type: "string", description: "The message text." } }, ["text"]),
      execute: async (args: { text: string }) => {
        const text = optionalText(args.text);
        if (!text) fail("text is empty");
        return send([{ type: "text", value: text }]);
      },
    }),

    send_buttons: llm.tool({
      description: BUTTONS_GUIDANCE,
      parameters: strict({
        text: { type: "string", description: "The question or step the buttons answer." },
        buttons: {
          type: "array",
          description: "1 to 5 buttons.",
          items: strict({
            label: { type: "string", description: "1 to 80 characters; what a tap sends back." },
            url: { type: "string", description: "Optional http(s) URL the button opens instead." },
          }, ["label"]),
        },
      }, ["text", "buttons"]),
      execute: async (args: { text: string; buttons: unknown }) => {
        const part = buttonsPart(args.buttons);
        if (typeof part === "string") return fail(part);
        return send(partsWithButtons(optionalText(args.text), part));
      },
    }),

    send_selection: llm.tool({
      description: SELECTION_GUIDANCE,
      parameters: strict({
        text: TEXT,
        title: { type: "string", description: "The question, 1 to 60 characters." },
        multiple: { type: "boolean", description: "Whether the person may check several rows. Defaults to true." },
        options: {
          type: "array",
          description: "1 to 25 rows.",
          items: strict({
            id: { type: "string", description: "Stable id returned in selected_ids, 1 to 200 characters." },
            label: { type: "string", description: "1 to 24 characters." },
            subtitle: { type: "string", description: "Optional, up to 72 characters." },
          }, ["id", "label"]),
        },
      }, ["title", "options"]),
      execute: async (args: {
        text?: string; title: string; multiple?: boolean; options: unknown;
      }) => {
        const part = selectionPart({
          type: "selection",
          title: args.title,
          ...(args.multiple === undefined ? {} : { multiple: args.multiple }),
          options: args.options,
        });
        if (typeof part === "string") return fail(part);
        return send(partsWithSelection(optionalText(args.text), part));
      },
    }),

    send_place: llm.tool({
      description: "Send a place as a map pin: a meeting point, a restaurant, an address you named. "
        + "The person can open it in their maps app.",
      parameters: strict({
        latitude: { type: "number", description: "Latitude in degrees, -90 to 90." },
        longitude: { type: "number", description: "Longitude in degrees, -180 to 180." },
        name: { type: "string", description: "Optional name of the place." },
        address: { type: "string", description: "Optional street address." },
      }, ["latitude", "longitude"]),
      execute: async (args: {
        latitude: number; longitude: number; name?: string; address?: string;
      }) => {
        const { latitude, longitude } = args;
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) fail("latitude must be -90 to 90");
        if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) fail("longitude must be -180 to 180");
        const place: PlacePart = {
          type: "place",
          latitude,
          longitude,
          ...(args.name ? { name: args.name } : {}),
          ...(args.address ? { address: args.address } : {}),
        };
        return send([place]);
      },
    }),

    request_location: llm.tool({
      description: "Ask the person in this one-to-one chat to share their location. Relay sends them a card "
        + "with a Share My Location button, and they choose how long to share. Then use read_location.",
      execute: async () => {
        await relay.chats.location.request(chatId);
        return { status: "requested" as const };
      },
    }),

    read_location: llm.tool({
      description: "Read where the person sharing their location with you in this chat is now: latitude, "
        + "longitude, and when that position arrived. Returns not_sharing when nobody is sharing.",
      execute: async (): Promise<RelayLocationReadResult> => {
        const { data } = await relay.chats.location.retrieve(chatId);
        if (data.features.length === 0) return { status: "not_sharing" };
        return {
          status: "sharing",
          locations: data.features.map(({ geometry, properties }) => ({
            handle: properties.handle,
            latitude: geometry.coordinates[1],
            longitude: geometry.coordinates[0],
            updated_at: properties.updated_at,
          })),
        };
      },
    }),

    send_link: llm.tool({
      description: "Send a web page as a link card with its title and image: an article, a listing, a product "
        + "page, a place's website. One link per message; never read a URL aloud instead.",
      parameters: strict({
        url: { type: "string", description: `An absolute http(s) URL, at most ${LINK_URL_MAX_LENGTH} characters.` },
      }, ["url"]),
      execute: async (args: { url: string }) => {
        const url = typeof args.url === "string" ? standaloneLink(args.url) : undefined;
        if (!url) return fail("url is not an absolute http(s) URL");
        return send([{ type: "link", value: url }]);
      },
    }),
  };
}

/** The words a Relay Message carries for the model, or undefined when it has none. */
const messageContent = (message: Message): string | undefined => {
  const parts = message.parts ?? [];
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === "text" || part.type === "link") lines.push(part.value);
  }
  const location = locationContext(parts);
  if (location) lines.push(location);
  const components = selectionReplyContext(selectionReply(parts, message.reply_to), {
    parts,
    ...(message.reply_to ? { reply_to: message.reply_to } : {}),
  });
  if (components) lines.push(components);
  const content = lines.join("\n").trim();
  return content || undefined;
};

/**
 * The chat's recent Messages as a LiveKit `ChatContext`, oldest first: the
 * agent's own as `assistant`, everyone else's as `user`. System Messages and
 * Messages with nothing to say are left out. Pass it as an Agent's `chatCtx`
 * so the call picks up where the texting left off.
 */
export async function relayChatContext(
  relay: RelayChatClient,
  chatId: string,
  limit = 20,
): Promise<llm.ChatContext> {
  const page = await relay.chats.messages.list(chatId, { order: "desc", limit });
  const chatCtx = llm.ChatContext.empty();
  for (const message of [...page.data].reverse()) {
    if (message.is_system_message) continue;
    const content = messageContent(message);
    if (!content) continue;
    const createdAt = Date.parse(message.created_at);
    chatCtx.addMessage({
      id: message.id,
      role: message.is_from_me ? "assistant" : "user",
      content,
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    });
  }
  return chatCtx;
}
