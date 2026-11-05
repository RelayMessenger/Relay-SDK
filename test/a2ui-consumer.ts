import type {
  A2uiActionMessage,
  A2uiRendererCapabilities,
  DataPart,
  DataPartResponse,
  MessageContent,
  MessagePartResponse,
  RelayWebhookEvent,
  SentMessage,
} from "@relaymessenger/sdk";

// Server 5a860e17: an agent sends an A2UI v1.0 card as a data part.
const card: DataPart = {
  type: "data",
  media_type: "application/a2ui+json",
  data: [{ version: "v1.0", createSurface: { surfaceId: "s1", catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json" } }],
};
const message: MessageContent = { parts: [card] };
// @ts-expect-error DataPart's data has minItems 1.
const empty: DataPart = { type: "data", media_type: "application/a2ui+json", data: [] };
// @ts-expect-error The only media type is application/a2ui+json.
const otherType: DataPart = { type: "data", media_type: "application/json", data: card.data };
// @ts-expect-error An agent sends agent-to-renderer messages; a tap is the renderer's.
const tapSent: DataPart = { type: "data", media_type: "application/a2ui+json", data: [{ version: "v1.0", action: { name: "x", surfaceId: "s1", sourceComponentId: "b", timestamp: "", context: {} } }] };

const read: DataPartResponse = { type: "data", media_type: "application/a2ui+json", data: [], reactions: null };
const asResponse: MessagePartResponse = read;
const asSent: SentMessage["parts"][number] = read;

export function tapOn(event: RelayWebhookEvent): A2uiActionMessage["action"] | null {
  if (event.event_type !== "message.received") return null;
  const capabilities: A2uiRendererCapabilities | undefined = event.data.metadata?.a2uiRendererCapabilities;
  const catalogs: string[] | undefined = capabilities?.["v1.0"].supportedCatalogIds;
  void catalogs;
  for (const part of event.data.parts) {
    if (part.type !== "data") continue;
    for (const entry of part.data) if ("action" in entry) return entry.action;
  }
  return null;
}
void message; void empty; void otherType; void tapSent; void asResponse; void asSent;
