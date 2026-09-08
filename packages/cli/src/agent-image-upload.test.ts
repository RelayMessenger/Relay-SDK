import type Relay from "@relaymessenger/sdk";
import { expect, it, vi } from "vitest";
import { uploadAgentImage } from "./agent-image-upload.js";
const card = { handle: "local_photo.dev", first_name: "Local Photo", last_name: null, image_url: "https://api.staging.relayapp.im/images/photo.png", kind: "agent" as const, is_active: true };
const image = { path: "/unused.png", filename: "photo.png", contentType: "image/png", size: 3, data: new Uint8Array([1, 2, 3]) };
function fixture() {
  const methods = {
    card: vi.fn(async () => ({ contact_cards: [card] })),
    allocate: vi.fn(async () => ({ attachment_id: "attachment-id", upload_url: "https://upload.staging.test/opaque", download_url: "https://download.staging.test/opaque", http_method: "PUT" as const, expires_at: "2026-09-08T12:00:00Z", required_headers: {} })),
    upload: vi.fn(async () => undefined),
    retrieve: vi.fn(async () => ({ id: "attachment-id", status: "complete" })),
    promote: vi.fn(async () => card),
  };
  const client = { contactCard: { retrieve: methods.card }, attachments: { create: methods.allocate, upload: methods.upload, retrieve: methods.retrieve } } as unknown as Pick<Relay, "attachments" | "contactCard">;
  return { methods, client };
}
it("allocates/uploads/checks completion then delegates promotion once", async () => {
  const { methods, client } = fixture();
  expect(await uploadAgentImage({ handle: card.handle, image }, client, methods.promote)).toEqual({ status: "updated", attachment_id: "attachment-id", agent: card });
  expect(methods.allocate).toHaveBeenCalledWith({ filename: "photo.png", content_type: "image/png", size_bytes: 3 }, { maxRetries: 0 });
  expect(methods.upload).toHaveBeenCalledOnce(); expect(methods.retrieve).toHaveBeenCalledWith("attachment-id", { maxRetries: 0 });
  expect(methods.promote).toHaveBeenCalledWith("attachment-id");
  expect(methods.upload.mock.invocationCallOrder[0]).toBeLessThan(methods.promote.mock.invocationCallOrder[0]!);
});
it.each(["allocate", "upload", "retrieve", "promote"] as const)("keeps safe partial outcome on uncertain %s, with no auto-retry", async (method) => {
  const { methods, client } = fixture(); methods[method].mockRejectedValue(new Error("private-secret-upload-url"));
  const result = await uploadAgentImage({ handle: card.handle, image }, client, methods.promote);
  expect(result.status).toBe("incomplete"); expect(JSON.stringify(result)).not.toContain("private-secret-upload-url");
  expect(methods[method]).toHaveBeenCalledOnce();
});
it("resumes promotion of a complete owned attachment without allocating or uploading again", async () => {
  const { methods, client } = fixture();
  expect((await uploadAgentImage({ handle: card.handle, attachmentID: "attachment-id" }, client, methods.promote)).status).toBe("updated");
  expect(methods.allocate).not.toHaveBeenCalled(); expect(methods.upload).not.toHaveBeenCalled(); expect(methods.promote).toHaveBeenCalledOnce();
});
it("does not upload using a credential for another identity", async () => {
  const { methods, client } = fixture();
  const result = await uploadAgentImage({ handle: "other.dev", image }, client, methods.promote);
  expect(result).toMatchObject({ status: "incomplete", phase: "agent" }); expect(methods.allocate).not.toHaveBeenCalled();
});
