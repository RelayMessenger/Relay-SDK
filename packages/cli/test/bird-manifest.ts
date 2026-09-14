import { createHash } from "node:crypto";

/** A stand-in for GET <api>/avatars/manifest.json: 84 birds, so a test never
 * reads the live manifest. Every other request goes to the delegate. */
export const birdFiles = Array.from({ length: 84 }, (_, index) => `relay-agent-bird-${index.toString(16).padStart(16, "0")}.png`);

/** The bird the server's rule picks for a handle (Relay-Server default-avatar.ts). */
export const birdFor = (apiURL: string, handle: string): string =>
  `${apiURL}/avatars/${birdFiles[createHash("sha256").update(handle, "utf8").digest()[0]! % 84]}`;

export const withBirdManifest = (
  delegate: typeof globalThis.fetch = async () => { throw new Error("no network in tests"); },
): typeof globalThis.fetch => async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/avatars/manifest.json") return Response.json({ assets: birdFiles.map((file) => ({ file })), count: 84 });
  return delegate(input, init);
};
