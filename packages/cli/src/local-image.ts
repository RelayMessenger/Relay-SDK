import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

// Existing RequestUploadRequest.size_bytes maximum in the canonical OpenAPI.
export const MAX_ATTACHMENT_IMAGE_BYTES = 104_857_600;
const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp", ".ico": "image/x-icon",
};
export interface LocalAgentImage { path: string; filename: string; contentType: string; data: Uint8Array; size: number }
export type AgentImageInput = { kind: "url"; url: string } | { kind: "file"; file: LocalAgentImage };
function imageSignature(data: Uint8Array, type: string): boolean {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const prefix = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  if (type === "image/png") return prefix("89504e470d0a1a0a");
  if (type === "image/jpeg") return prefix("ffd8ff");
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (type === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (type === "image/tiff") return prefix("49492a00") || prefix("4d4d002a");
  if (type === "image/bmp") return prefix("424d");
  if (type === "image/x-icon") return prefix("00000100");
  if (type === "image/heic" || type === "image/heif") {
    return bytes.subarray(4, 8).toString("ascii") === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(bytes.subarray(8, 12).toString("ascii"));
  }
  return false;
}
/** Preflight is local only: no bootstrap, HTTP, image generation, or promotion.
 * The server owns completed-upload ownership and promotion validation. */
export async function prepareAgentImage(
  input: string,
  options: { cwd?: string; home?: string; maxBytes?: number } = {},
): Promise<AgentImageInput> {
  if (/^https?:\/\//iu.test(input)) {
    let url: URL; try { url = new URL(input); } catch { throw new Error("Image URL is invalid."); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Image URL must use HTTPS without credentials.");
    return { kind: "url", url: input };
  }
  if (!input || (/^[a-z][a-z0-9+.-]*:/iu.test(input) && !/^[a-z]:[\\/]/iu.test(input))) throw new Error("Image must be a local file or HTTPS URL.");
  const expanded = input.startsWith("~/") ? join(options.home ?? homedir(), input.slice(2)) : input;
  const path = resolve(options.cwd ?? process.cwd(), expanded);
  const maximum = options.maxBytes ?? MAX_ATTACHMENT_IMAGE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error("Invalid local image size limit.");
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Image must be a regular file.");
    const contentType = imageTypes[extname(path).toLowerCase()];
    const filename = basename(path);
    if (!contentType || filename.length > 255 || /[\u0000-\u001f\u007f]/u.test(filename)) throw new Error("Unsupported image filename/type.");
    if (before.size < 1 || before.size > maximum) throw new Error("Image size is out of range.");
    const file = await open(path, "r");
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("Image changed while opening.");
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw new Error("Image changed while reading.");
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || !imageSignature(data, contentType)) throw new Error("Image changed or file signature is invalid.");
      return { kind: "file", file: { path, filename, contentType, data, size: data.length } };
    } finally { await file.close(); }
  } catch {
    throw new Error(`Local image must be a readable supported image file between 1 and ${maximum} bytes. No agent was created.`);
  }
}
