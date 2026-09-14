import { createHash } from "node:crypto";

/** A stand-in for GET <api>/avatars/manifest.json: 84 birds, so a test never
 * reads the live manifest. Every other request goes to the delegate. */
export const birdFiles = Array.from({ length: 84 }, (_, index) => `relay-agent-bird-${index.toString(16).padStart(16, "0")}.png`);

/** The bird the server's rule picks for a handle (Relay-Server default-avatar.ts). */
export const birdFor = (apiURL: string, handle: string): string =>
  `${apiURL}/avatars/${birdFiles[createHash("sha256").update(handle, "utf8").digest()[0]! % 84]}`;

/** Answers the manifest, and the contact-card update that sets the bird after
 * creation (recorded in `pictures`); every other request goes to the delegate. */
export const withBirdManifest = (
  delegate: typeof globalThis.fetch = async () => { throw new Error("no network in tests"); },
  pictures: Array<{ handle: string | null; image_url: unknown }> = [],
): typeof globalThis.fetch => async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/avatars/manifest.json") return Response.json({ assets: birdFiles.map((file) => ({ file })), count: 84 });
  if (url.pathname === "/v1/contact_card" && init?.method === "PATCH") {
    const body = JSON.parse(String(init.body)) as { image_url?: unknown };
    const handle = url.searchParams.get("handle");
    pictures.push({ handle, image_url: body.image_url });
    return Response.json({ handle, first_name: "My Agent", last_name: null, image_url: body.image_url, is_active: true, kind: "agent" });
  }
  return delegate(input, init);
};
