import type Relay from "@relaymessenger/sdk";
import {
  BUTTONS_MAX_ITEMS,
  LINK_URL_MAX_LENGTH,
  SELECTION_MAX_OPTIONS,
  buttonsPart,
  locationContext,
  selectionPart,
  standaloneLink,
  type Message,
  type MessagePart,
  type PlacePart,
} from "@relaymessenger/sdk";

/** The Relay chat tools an ElevenLabs agent may call during a Relay Call. */
export const RELAY_TOOL_NAMES = [
  "send_message",
  "send_buttons",
  "send_selection",
  "send_place",
  "request_location",
  "read_location",
  "send_link",
] as const;

export type RelayToolName = (typeof RELAY_TOOL_NAMES)[number];

/** JSON Schema subset ElevenLabs takes for a client tool's parameters. */
export interface ElevenLabsToolParameters {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

/**
 * One client tool as ElevenLabs' Tools API takes it: the `tool_config` of
 * `POST /v1/convai/tools` with `type: "client"`
 * (https://elevenlabs.io/docs/agents-platform/api-reference/tools/create).
 */
export interface ElevenLabsClientTool {
  type: "client";
  name: RelayToolName;
  description: string;
  parameters: ElevenLabsToolParameters;
  expects_response: true;
}

const text = (description: string) => ({ type: "string", description });
const optionalText = {
  text: text("Words sent as a normal message bubble with it. Optional."),
};

const tool = (
  name: RelayToolName,
  description: string,
  properties: Record<string, Record<string, unknown>> = {},
  required: string[] = [],
): ElevenLabsClientTool => ({
  type: "client",
  name,
  description,
  parameters: { type: "object", properties, required },
  expects_response: true,
});

/**
 * The seven Relay chat tools as ElevenLabs client tools. Create each with
 * `POST /v1/convai/tools` (`{ tool_config }`) and list the ids in the agent's
 * `tool_ids`, or add them in the dashboard with these exact names (names are
 * case-sensitive). `ElevenLabsCall` with `relayTools` answers them.
 */
export const relayClientTools: readonly ElevenLabsClientTool[] = [
  tool(
    "send_message",
    "Text the person in this call's Relay chat. Use it for anything they should keep: an address, a number, a list, a summary.",
    { text: text("The message text."), reply_to_message_id: text("A message in the chat to reply to.") },
    ["text"],
  ),
  tool(
    "send_buttons",
    `Text the person a question with 1 to ${BUTTONS_MAX_ITEMS} buttons under it. A tap sends the label back as their reply; a button with a url opens that page instead.`,
    {
      ...optionalText,
      buttons: {
        type: "array",
        description: `1 to ${BUTTONS_MAX_ITEMS} buttons.`,
        items: {
          type: "object",
          description: "One button.",
          properties: {
            label: text("The button's text, at most 80 characters."),
            url: text("An https page the button opens. Optional."),
          },
          required: ["label"],
        },
      },
    },
    ["buttons"],
  ),
  tool(
    "send_selection",
    `Text the person a list of 1 to ${SELECTION_MAX_OPTIONS} options to pick from and send back once.`,
    {
      ...optionalText,
      title: text("The question, 1 to 60 characters."),
      subtitle: text("A second line under the title. Optional."),
      multiple: { type: "boolean", description: "True lets the person pick more than one option." },
      options: {
        type: "array",
        description: `1 to ${SELECTION_MAX_OPTIONS} options.`,
        items: {
          type: "object",
          description: "One option.",
          properties: {
            id: text("A stable id for the option, 1 to 24 characters."),
            label: text("The option's text, 1 to 24 characters."),
            subtitle: text("A short description of the option. Optional."),
          },
          required: ["id", "label"],
        },
      },
    },
    ["title", "options"],
  ),
  tool(
    "send_place",
    "Text the person a place as a map pin.",
    {
      ...optionalText,
      latitude: { type: "number", description: "Latitude in degrees, -90 to 90." },
      longitude: { type: "number", description: "Longitude in degrees, -180 to 180." },
      name: text("The place's name. Optional."),
      address: text("The place's address. Optional."),
    },
    ["latitude", "longitude"],
  ),
  tool(
    "request_location",
    "Ask the person to share their location with you in the Relay chat. Read it with read_location after they share.",
  ),
  tool(
    "read_location",
    "Read the current location of everyone sharing their location with you in this chat.",
  ),
  tool(
    "send_link",
    "Text the person a link, drawn as a card with the page's title and image.",
    { ...optionalText, url: text(`An http or https URL, at most ${LINK_URL_MAX_LENGTH} characters.`) },
    ["url"],
  ),
];

export const isRelayToolName = (name: unknown): name is RelayToolName =>
  typeof name === "string" && (RELAY_TOOL_NAMES as readonly string[]).includes(name);

/** A tool call the agent made with arguments the tool cannot use; the agent is told why. */
export class RelayToolArgumentError extends Error {}

type Args = Record<string, unknown>;

const optionalString = (args: Args, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RelayToolArgumentError(`${key} must be a string`);
  return value;
};

const requiredString = (args: Args, key: string): string => {
  const value = optionalString(args, key);
  if (!value?.trim()) throw new RelayToolArgumentError(`${key} is required`);
  return value;
};

const textPart = (args: Args): MessagePart[] => {
  const value = optionalString(args, "text");
  return value?.trim() ? [{ type: "text", value }] : [];
};

const send = async (relay: Relay, chatId: string, parts: MessagePart[], replyTo?: string): Promise<string> => {
  const sent = await relay.chats.messages.send(chatId, {
    message: { parts, ...(replyTo ? { reply_to: { message_id: replyTo } } : {}) },
  });
  return JSON.stringify({ sent: true, message_id: sent.message.id });
};

/**
 * Runs one Relay tool for the chat and returns the text ElevenLabs gives the
 * model as the tool's result. Throws `RelayToolArgumentError` for unusable
 * arguments and the SDK's errors for refused requests.
 */
export const runRelayTool = async (
  relay: Relay,
  chatId: string,
  name: RelayToolName,
  args: Args,
): Promise<string> => {
  switch (name) {
    case "send_message":
      return send(
        relay,
        chatId,
        [{ type: "text", value: requiredString(args, "text") }],
        optionalString(args, "reply_to_message_id")?.trim() || undefined,
      );
    case "send_buttons": {
      const buttons = buttonsPart(args.buttons);
      if (typeof buttons === "string") throw new RelayToolArgumentError(buttons);
      return send(relay, chatId, [...textPart(args), buttons]);
    }
    case "send_selection": {
      const selection = selectionPart({
        title: args.title,
        options: args.options,
        ...(args.subtitle !== undefined && args.subtitle !== null ? { subtitle: args.subtitle } : {}),
        ...(args.multiple !== undefined && args.multiple !== null ? { multiple: args.multiple } : {}),
      });
      if (typeof selection === "string") throw new RelayToolArgumentError(selection);
      return send(relay, chatId, [...textPart(args), selection]);
    }
    case "send_place": {
      const { latitude, longitude } = args;
      if (typeof latitude !== "number" || !(latitude >= -90 && latitude <= 90)) {
        throw new RelayToolArgumentError("latitude must be a number from -90 to 90");
      }
      if (typeof longitude !== "number" || !(longitude >= -180 && longitude <= 180)) {
        throw new RelayToolArgumentError("longitude must be a number from -180 to 180");
      }
      const name = optionalString(args, "name")?.trim();
      const address = optionalString(args, "address")?.trim();
      const place: PlacePart = {
        type: "place",
        latitude,
        longitude,
        ...(name ? { name } : {}),
        ...(address ? { address } : {}),
      };
      return send(relay, chatId, [...textPart(args), place]);
    }
    case "request_location":
      await relay.chats.location.request(chatId);
      return JSON.stringify({ requested: true });
    case "read_location": {
      const location = await relay.chats.location.retrieve(chatId);
      return JSON.stringify({
        sharing: location.data.features.map((feature) => ({
          handle: feature.properties.handle,
          latitude: feature.geometry.coordinates[1],
          longitude: feature.geometry.coordinates[0],
          updated_at: feature.properties.updated_at,
        })),
      });
    }
    case "send_link": {
      const url = standaloneLink(requiredString(args, "url"));
      if (!url) throw new RelayToolArgumentError(`url must be one http or https URL of at most ${LINK_URL_MAX_LENGTH} characters`);
      // A link part travels alone in its Message (LINK_LINE_INSTRUCTION); the words go first.
      const words = textPart(args);
      if (words.length) await relay.chats.messages.send(chatId, { message: { parts: words } });
      return send(relay, chatId, [{ type: "link", value: url }]);
    }
  }
};

const messageText = (message: Message): string => {
  const words = (message.parts ?? []).flatMap((part) =>
    part.type === "text" || part.type === "link" ? [part.value] : []);
  const place = locationContext(message.parts ?? []);
  return [...words, ...(place ? [place] : [])].join("\n");
};

/**
 * The chat's recent Messages, oldest first, as text for the conversation's
 * `initiationData.dynamic_variables` (for example `{ relay_chat: await
 * relayChatContext(relay, chatId) }`, read in the prompt as `{{relay_chat}}`).
 * One line per Message: `You:` for the agent, the sender's handle otherwise.
 */
export const relayChatContext = async (relay: Relay, chatId: string, limit = 20): Promise<string> => {
  const page = await relay.chats.messages.list(chatId, { limit, order: "desc" });
  return page.data
    .slice(0, limit)
    .reverse()
    .flatMap((message) => {
      const body = messageText(message);
      if (!body) return [];
      const who = message.is_from_me ? "You" : message.from_handle?.handle ?? message.from ?? "Person";
      return [`${who}: ${body}`];
    })
    .join("\n");
};
