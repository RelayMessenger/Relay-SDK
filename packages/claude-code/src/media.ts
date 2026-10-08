import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type Relay from "@relaymessenger/sdk";
import type { MediaPart, SupportedContentType } from "@relaymessenger/sdk";

/** One file the reply tool attaches: a local file to upload, or a public https URL Relay fetches. */
export interface MediaInput {
  readonly path?: string;
  readonly url?: string;
  readonly content_type?: string;
}

// The same extension table as the relaymessenger CLI's `attachments upload`.
const EXTENSIONS: Record<string, SupportedContentType> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", heic: "image/heic", heif: "image/heif",
  tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/x-m4a",
  wav: "audio/x-wav", aac: "audio/aac", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", html: "text/html", vcf: "text/vcard", ics: "text/calendar",
};

/** The media arguments, checked; a string is the reason they are refused. */
export function mediaInputs(value: unknown): MediaInput[] | string {
  if (!Array.isArray(value) || value.length === 0) return "media must be a non-empty array";
  const inputs: MediaInput[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return "each media item must be an object";
    const { path, url, content_type: contentType, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return `unknown media field ${Object.keys(rest)[0]}`;
    if ((path === undefined) === (url === undefined)) return "each media item takes path or url, not both";
    if (path !== undefined && (typeof path !== "string" || !isAbsolute(path))) return "media path must be an absolute local file path";
    if (url !== undefined && (typeof url !== "string" || !/^https:\/\/\S+$/u.test(url) || url.length > 2048)) {
      return "media url must be one public https URL";
    }
    if (contentType !== undefined && (typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/u.test(contentType))) {
      return "media content_type must be a MIME type such as image/png";
    }
    if (contentType !== undefined && url !== undefined) return "content_type goes only with path; Relay reads a URL's type itself";
    inputs.push({
      ...(path !== undefined ? { path: path as string } : { url: url as string }),
      ...(contentType !== undefined ? { content_type: contentType as string } : {}),
    });
  }
  return inputs;
}

/**
 * Turns media inputs into media parts. A URL is passed through for Relay to
 * fetch; a local file is uploaded through `attachments.create`. An upload is
 * remembered by reply key, position and file bytes, so a retry of the same
 * reply in this process sends the same attachment on the same idempotency key.
 */
export class MediaUploader {
  readonly #uploaded = new Map<string, string>();
  readonly #relay: Pick<Relay, "attachments">;

  constructor(relay: Pick<Relay, "attachments">) {
    this.#relay = relay;
  }

  async parts(inputs: readonly MediaInput[], replyKey: string): Promise<MediaPart[]> {
    const parts: MediaPart[] = [];
    for (const [index, input] of inputs.entries()) {
      if (input.url !== undefined) {
        parts.push({ type: "media", url: input.url });
        continue;
      }
      parts.push({ type: "media", attachment_id: await this.#upload(input.path!, input.content_type, replyKey, index) });
    }
    return parts;
  }

  async #upload(path: string, given: string | undefined, replyKey: string, index: number): Promise<string> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`media path ${path} is not a file`);
    const data = await readFile(path);
    const cacheKey = `${replyKey}\0${index}\0${createHash("sha256").update(data).digest("hex")}`;
    const known = this.#uploaded.get(cacheKey);
    if (known) return known;
    const filename = basename(path);
    const extension = /\.([^.]+)$/u.exec(filename)?.[1]?.toLowerCase();
    const contentType = given ?? (extension && Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined);
    if (!contentType) throw new Error(`could not tell the type of ${filename}; give content_type`);
    const allocation = await this.#relay.attachments.create({
      filename,
      content_type: contentType,
      size_bytes: data.byteLength,
    });
    await this.#relay.attachments.upload(allocation, new Uint8Array(data));
    this.#uploaded.set(cacheKey, allocation.attachment_id);
    return allocation.attachment_id;
  }
}
