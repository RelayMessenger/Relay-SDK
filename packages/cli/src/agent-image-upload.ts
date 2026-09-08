import type Relay from "@relaymessenger/sdk";
import type { ContactCardItem } from "@relaymessenger/sdk";
import type { LocalAgentImage } from "./local-image.js";

export type AgentImageUploadPhase = "agent" | "prepare" | "upload" | "check" | "save";
export type AgentImageUploadResult =
  | { status: "updated"; attachment_id: string; agent: ContactCardItem }
  | { status: "incomplete"; phase: AgentImageUploadPhase; attachment_id?: string; message: string };

/** Uses only the signed-in file-upload calls that already exist. The caller passes
 * in the call that saves the picture on the agent; no route is rebuilt here.
 * A step whose outcome is unknown is never repeated on its own. */
export async function uploadAgentImage(
  input: { handle: string; image?: LocalAgentImage; attachmentID?: string },
  client: Pick<Relay, "attachments" | "contactCard">,
  promote: (attachmentID: string) => Promise<ContactCardItem>,
): Promise<AgentImageUploadResult> {
  let phase: AgentImageUploadPhase = "agent";
  let attachmentID = input.attachmentID;
  try {
    const cards = await client.contactCard.retrieve({}, { maxRetries: 0 });
    if (cards.contact_cards.length !== 1 || cards.contact_cards[0]?.handle !== input.handle || cards.contact_cards[0].kind !== "agent" || !cards.contact_cards[0].is_active) {
      throw new Error("This token belongs to a different agent.");
    }
    if (input.image && input.attachmentID) throw new Error("Choose either a new picture or a picture you already uploaded, not both.");
    if (!attachmentID) {
      if (!input.image) throw new Error("No picture was given.");
      phase = "prepare";
      const allocation = await client.attachments.create({
        filename: input.image.filename, content_type: input.image.contentType, size_bytes: input.image.size,
      }, { maxRetries: 0 });
      attachmentID = allocation.attachment_id;
      phase = "upload";
      await client.attachments.upload(allocation, new Blob([Uint8Array.from(input.image.data)], { type: input.image.contentType }), { maxRetries: 0, timeout: 120_000, signal: AbortSignal.timeout(120_000) });
    }
    phase = "check";
    const attachment = await client.attachments.retrieve(attachmentID, { maxRetries: 0 });
    if (attachment.status !== "complete") throw new Error("Relay has not finished storing this picture yet.");
    phase = "save";
    const agent = await promote(attachmentID);
    if (agent.handle !== input.handle || agent.kind !== "agent") throw new Error("Relay answered about a different agent.");
    return { status: "updated", attachment_id: attachmentID, agent };
  } catch {
    // Never return text from Relay or from the upload: either may echo the private
    // token or the temporary upload address.
    return {
      status: "incomplete", phase,
      ...(attachmentID ? { attachment_id: attachmentID } : {}),
      message: "The agent and its saved token are unchanged. The picture did not go through. Set the picture on this same agent; do not create another one.",
    };
  }
}
