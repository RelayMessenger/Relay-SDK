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
/** A rule this command checked itself, as opposed to an unexpected file error.
 * Marked so the outer catch can pass the exact reason through to the reader. */
const imageRule = (message: string): Error => Object.assign(new Error(message), { relayImageRule: true });
const readableSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
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
/** Checks the picture on this computer only. It creates nothing, sends nothing,
 * draws nothing, and saves nothing on the agent. Relay checks the finished
 * upload itself. */
export async function prepareAgentImage(
  input: string,
  options: { cwd?: string; home?: string; maxBytes?: number } = {},
): Promise<AgentImageInput> {
  if (/^https?:\/\//iu.test(input)) {
    let url: URL; try { url = new URL(input); } catch { throw imageRule("That picture address is not a valid web address."); }
    if (url.protocol !== "https:" || url.username || url.password) throw imageRule("A picture address must start with https:// and must not contain a user name or password.");
    return { kind: "url", url: input };
  }
  if (!input || (/^[a-z][a-z0-9+.-]*:/iu.test(input) && !/^[a-z]:[\\/]/iu.test(input))) throw imageRule("Give the path to a picture file on this computer, or an address that starts with https://");
  const expanded = input.startsWith("~/") ? join(options.home ?? homedir(), input.slice(2)) : input;
  const path = resolve(options.cwd ?? process.cwd(), expanded);
  const maximum = options.maxBytes ?? MAX_ATTACHMENT_IMAGE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ATTACHMENT_IMAGE_BYTES) throw imageRule(`The size limit passed to this command must be between 1 byte and ${readableSize(MAX_ATTACHMENT_IMAGE_BYTES)}.`);
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw imageRule(`${path} must be a regular file, not a link, a folder or a device.`);
    const contentType = imageTypes[extname(path).toLowerCase()];
    const filename = basename(path);
    if (!contentType) throw imageRule(`Relay does not accept ${extname(path) || "a file with no extension"}. Use one of: ${Object.keys(imageTypes).join(", ")}.`);
    if (filename.length > 255 || /[\u0000-\u001f\u007f]/u.test(filename)) throw imageRule("The file name must be under 256 characters and must not contain control characters.");
    if (before.size < 1 || before.size > maximum) throw imageRule(`The picture must be between 1 byte and ${readableSize(maximum)}. This one is ${readableSize(before.size)}.`);
    const file = await open(path, "r");
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw imageRule("The picture file changed while Relay was opening it. Run the command again.");
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw imageRule("The picture file changed while Relay was reading it. Run the command again.");
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw imageRule("The picture file changed while Relay was reading it. Run the command again.");
      if (!imageSignature(data, contentType)) throw imageRule(`The contents of this file are not ${contentType.replace("image/", "").toUpperCase()}, even though its name ends in ${extname(path).toLowerCase()}. Save it in the right format, or rename it.`);
      return { kind: "file", file: { path, filename, contentType, data, size: data.length } };
    } finally { await file.close(); }
  } catch (error) {
    // Pass through the exact rule the reader broke; only an unexpected file
    // error becomes the general message.
    if (error instanceof Error && (error as { relayImageRule?: boolean }).relayImageRule === true) throw error;
    throw new Error(`Relay could not read ${path}. Check the path, and that the file is a picture you can read and no larger than ${readableSize(maximum)}.`);
  }
}
