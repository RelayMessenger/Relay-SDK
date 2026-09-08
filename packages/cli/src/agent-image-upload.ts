import type Relay from "@relaymessenger/sdk";
import type { ContactCardItem } from "@relaymessenger/sdk";
import type { LocalAgentImage } from "./local-image.js";

export type AgentImageUploadPhase = "identity" | "allocation" | "upload" | "completion" | "promotion";
export type AgentImageUploadResult =
  | { status: "updated"; attachment_id: string; agent: ContactCardItem }
  | { status: "incomplete"; phase: AgentImageUploadPhase; attachment_id?: string; message: string };

/** Existing authenticated attachment lifecycle only. The caller supplies the
 * agreed SDK contact-card promotion operation; no route or HTTP implementation
 * is duplicated here. An uncertain operation is never automatically repeated. */
export async function uploadAgentImage(
  input: { handle: string; image?: LocalAgentImage; attachmentID?: string },
  client: Pick<Relay, "attachments" | "contactCard">,
  promote: (attachmentID: string) => Promise<ContactCardItem>,
): Promise<AgentImageUploadResult> {
  let phase: AgentImageUploadPhase = "identity";
  let attachmentID = input.attachmentID;
  try {
    const cards = await client.contactCard.retrieve({}, { maxRetries: 0 });
    if (cards.contact_cards.length !== 1 || cards.contact_cards[0]?.handle !== input.handle || cards.contact_cards[0].kind !== "agent" || !cards.contact_cards[0].is_active) {
      throw new Error("Selected token does not match the intended agent.");
    }
    if (input.image && input.attachmentID) throw new Error("Choose a new image or existing attachment.");
    if (!attachmentID) {
      if (!input.image) throw new Error("Image file required.");
      phase = "allocation";
      const allocation = await client.attachments.create({
        filename: input.image.filename, content_type: input.image.contentType, size_bytes: input.image.size,
      }, { maxRetries: 0 });
      attachmentID = allocation.attachment_id;
      phase = "upload";
      await client.attachments.upload(allocation, new Blob([Uint8Array.from(input.image.data)], { type: input.image.contentType }), { maxRetries: 0, timeout: 120_000, signal: AbortSignal.timeout(120_000) });
    }
    phase = "completion";
    const attachment = await client.attachments.retrieve(attachmentID, { maxRetries: 0 });
    if (attachment.status !== "complete") throw new Error("Attachment not complete.");
    phase = "promotion";
    const agent = await promote(attachmentID);
    if (agent.handle !== input.handle || agent.kind !== "agent") throw new Error("Promotion response does not match the intended agent.");
    return { status: "updated", attachment_id: attachmentID, agent };
  } catch {
    // Never return server/upload response text or exception details: either may
    // reflect the private token or temporary upload capability.
    return {
      status: "incomplete", phase,
      ...(attachmentID ? { attachment_id: attachmentID } : {}),
      message: "Agent identity and saved token are retained. Image update was not confirmed; retry the image on this existing identity, not agent creation.",
    };
  }
}
