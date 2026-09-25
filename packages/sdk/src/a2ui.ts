import type { Relay } from "./client.js";
import type {
  A2uiAction,
  A2uiComponent,
  A2uiCreateSurfaceMessage,
  A2uiMessage,
  A2uiServerToClientMessage,
  DataPart,
  MessageContent,
  MessagePart,
  MessageSendResponse,
  MessageWebhookData,
  RelayWebhookEvent,
  RequestOptions,
} from "./types.js";

/** The `media_type` of a data part that carries A2UI messages. */
export const A2UI_MEDIA_TYPE = "application/a2ui+json";

/** The A2UI version every message these helpers write carries. */
export const A2UI_VERSION = "v0.9.1";

/** A2UI v0.9.1's basic catalog, by the `catalogId` its catalog file declares. */
export const A2UI_BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

/** Relay's catalog: every basic catalog component and function, plus `PaymentRequest`. */
export const RELAY_A2UI_CATALOG_ID = "https://relayapp.im/a2ui/catalog/v1";

/** A card: the surface to create, its components, and, optionally, its first data model. */
export interface A2uiSurface {
  surfaceId: string;
  /** A catalog Relay draws: `A2UI_BASIC_CATALOG_ID` or `RELAY_A2UI_CATALOG_ID`. */
  catalogId: string;
  /** Every component of the card; one has the id `root`. */
  components: A2uiComponent[];
  /** The whole data model, sent as an `updateDataModel` with no `path`. */
  dataModel?: Record<string, unknown>;
  theme?: A2uiCreateSurfaceMessage["createSurface"]["theme"];
  sendDataModel?: boolean;
}

/**
 * A change to a card that is already in the chat: components to add or
 * replace by id, and a data model value to set at `path` (a JSON Pointer; no
 * `path` is the whole data model; no `value` removes the key at `path`).
 */
export interface A2uiSurfaceUpdate {
  components?: A2uiComponent[];
  dataModel?: { path?: string; value?: unknown };
}

/**
 * The rest of the Message beside the data part. `text` becomes a text part
 * before it; the chat list and notification show it. With no text, they show
 * the card's first `Text` component. A text beside an update is a new Message,
 * and the update still changes the card in place.
 */
export type A2uiSendOptions = Omit<MessageContent, "parts"> & { text?: string };

/** A tap read out of `message.received`. */
export interface A2uiTap {
  action: A2uiAction;
  /** The tapped surface's data model, present when the surface set `sendDataModel`. */
  dataModel?: Record<string, unknown>;
}

/** Wraps A2UI messages in the data part Relay carries them in. */
export const a2uiPart = (messages: A2uiMessage[]): DataPart => ({
  type: "data",
  media_type: A2UI_MEDIA_TYPE,
  data: messages,
});

const send = (
  client: Pick<Relay, "chats">,
  chatID: string,
  messages: A2uiServerToClientMessage[],
  { text, ...message }: A2uiSendOptions = {},
  options?: RequestOptions,
): Promise<MessageSendResponse> => {
  const parts: MessagePart[] = text === undefined
    ? [a2uiPart(messages)]
    : [{ type: "text", value: text }, a2uiPart(messages)];
  return client.chats.messages.send(chatID, { message: { ...message, parts } }, options);
};

/**
 * Sends a new card into a chat: `createSurface`, `updateComponents` and, when
 * `dataModel` is given, `updateDataModel`, in one data part. Messages Relay
 * could not apply come back in `a2ui_errors`; a send it could not apply at all
 * throws a `RelayAPIError` whose `body.a2ui_errors` lists each.
 */
export const sendA2uiSurface = (
  client: Pick<Relay, "chats">,
  chatID: string,
  surface: A2uiSurface,
  message?: A2uiSendOptions,
  options?: RequestOptions,
): Promise<MessageSendResponse> => {
  const { surfaceId, catalogId, components, dataModel, theme, sendDataModel } = surface;
  const messages: A2uiServerToClientMessage[] = [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId,
        ...(theme === undefined ? {} : { theme }),
        ...(sendDataModel === undefined ? {} : { sendDataModel }),
      },
    },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
  ];
  if (dataModel !== undefined) {
    messages.push({ version: A2UI_VERSION, updateDataModel: { surfaceId, value: dataModel } });
  }
  return send(client, chatID, messages, message, options);
};

/**
 * Changes a card already in the chat, in place, for every member. With no
 * `text`, the send adds no Message and returns the card's own Message. Any
 * agent in the chat may update any surface in it.
 */
export const updateA2uiSurface = (
  client: Pick<Relay, "chats">,
  chatID: string,
  surfaceId: string,
  update: A2uiSurfaceUpdate,
  message?: A2uiSendOptions,
  options?: RequestOptions,
): Promise<MessageSendResponse> => {
  const messages: A2uiServerToClientMessage[] = [];
  if (update.components !== undefined) {
    messages.push({ version: A2UI_VERSION, updateComponents: { surfaceId, components: update.components } });
  }
  if (update.dataModel !== undefined) {
    messages.push({ version: A2UI_VERSION, updateDataModel: { surfaceId, ...update.dataModel } });
  }
  if (!messages.length) throw new Error("an update needs components or a dataModel");
  return send(client, chatID, messages, message, options);
};

/**
 * Removes a card for everyone. When every surface a Message draws is deleted,
 * the Message reads back with no parts and a non-null `unsent_at`. The
 * `surfaceId` may be created again afterwards.
 */
export const deleteA2uiSurface = (
  client: Pick<Relay, "chats">,
  chatID: string,
  surfaceId: string,
  message?: A2uiSendOptions,
  options?: RequestOptions,
): Promise<MessageSendResponse> =>
  send(client, chatID, [{ version: A2UI_VERSION, deleteSurface: { surfaceId } }], message, options);

/**
 * Reads the first A2UI `action` out of a `message.received` event (a signed
 * webhook or a WebSocket event), or out of its `data`. Returns null for any
 * other event and for a Message that carries no tap. When the surface set
 * `sendDataModel`, `dataModel` is that surface's model from
 * `metadata.a2uiClientDataModel`.
 */
export const readA2uiAction = (
  event: RelayWebhookEvent | MessageWebhookData,
): A2uiTap | null => {
  let data: MessageWebhookData;
  if ("event_type" in event) {
    if (event.event_type !== "message.received") return null;
    data = event.data;
  } else {
    data = event;
  }
  for (const part of data.parts ?? []) {
    if (part.type !== "data" || part.media_type !== A2UI_MEDIA_TYPE) continue;
    for (const message of part.data) {
      if (typeof message !== "object" || message === null || !("action" in message)) continue;
      const { action } = message;
      const dataModel = data.metadata?.a2uiClientDataModel?.surfaces[action.surfaceId];
      return dataModel === undefined ? { action } : { action, dataModel };
    }
  }
  return null;
};
