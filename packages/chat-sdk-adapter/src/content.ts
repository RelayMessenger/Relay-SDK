import {
  cardToFallbackText,
  extractCard,
  extractFiles,
  extractPostableAttachments,
  toBuffer,
  type PlatformName,
  ValidationError,
} from "@chat-adapter/shared";
import {
  markdownToPlainText,
  toPlainText,
  type AdapterPostableMessage,
  type Attachment,
  type FileUpload,
} from "chat";
import type { RelayOutgoingPart } from "./types.js";

/**
 * Allocate a Relay Attachment and put the bytes behind it, returning the ID a
 * media part references. `RelayClient.uploadAttachment` satisfies this.
 */
export type RelayMediaUploader = (upload: {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename: string;
  height?: number;
  width?: number;
}) => Promise<{ attachment_id: string }>;

/**
 * `toBuffer`'s `platform` only names the four adapters that shipped with the
 * helper and is used for nothing but an error string. `throwOnUnsupported` is
 * off here so that string never reaches a caller: an unusable body is refused
 * below with Relay's own message and the file's name in it.
 */
const TO_BUFFER_OPTIONS = {
  platform: "relay" as PlatformName,
  throwOnUnsupported: false,
} as const;

export const RELAY_MAX_TEXT_PART_LENGTH = 10_000;
export const RELAY_MAX_MESSAGE_PARTS = 100;
export const RELAY_MAX_ATTACHMENT_BYTES = 104_857_600;

/**
 * Relay accepts any syntactically valid media type for an Attachment and
 * stores the original bytes unchanged, so this adapter validates the shape of
 * a declared content type instead of matching it against a list. Only
 * pictures and group icons must be images, and those are set through
 * `@relaymessenger/sdk`, never here.
 */
export const RELAY_MAX_CONTENT_TYPE_LENGTH = 255;
export const RELAY_FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * RFC 2045 `token`: printable US-ASCII without SPACE, CTLs, or tspecials
 * (`(` `)` `<` `>` `@` `,` `;` `:` `\` `"` `/` `[` `]` `?` `=`).
 */
const RFC_2045_TOKEN = "[!#$%&'*+.^_`|~{}0-9A-Za-z-]+";
const MEDIA_TYPE = new RegExp(
  `^${RFC_2045_TOKEN}/${RFC_2045_TOKEN}$`,
  "u",
);

const MIME_BY_EXTENSION: Record<string, string> = {
  aac: "audio/aac",
  aiff: "audio/aiff",
  avi: "video/x-msvideo",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  gif: "image/gif",
  gz: "application/x-gzip",
  heic: "image/heic",
  heif: "image/heif",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/x-m4a",
  md: "text/markdown",
  midi: "audio/midi",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "text/rtf",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  vcf: "text/vcard",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "text/xml",
  zip: "application/zip",
};

export function contentTypeFor(
  filename: string,
  declared?: string,
): string {
  const normalized = declared?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized) {
    if (
      normalized.length > RELAY_MAX_CONTENT_TYPE_LENGTH
      || !MEDIA_TYPE.test(normalized)
    ) {
      throw new ValidationError(
        "relay",
        `Relay cannot use ${JSON.stringify(
          declared,
        )} as the content type for ${JSON.stringify(filename)}; pass a `
          + `"type/subtype" media type of at most `
          + `${RELAY_MAX_CONTENT_TYPE_LENGTH} characters`,
      );
    }
    return normalized;
  }
  const extension = filename.split(".").at(-1)?.toLowerCase();
  return (extension ? MIME_BY_EXTENSION[extension] : undefined)
    ?? RELAY_FALLBACK_CONTENT_TYPE;
}

export function postableText(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  const card = extractCard(message);
  if (card) {
    const explicit =
      "fallbackText" in message ? message.fallbackText : undefined;
    const rendered = explicit?.trim()
      ? explicit
      : cardToFallbackText(card, { lineBreak: "\n\n" });
    if (!rendered.trim()) {
      throw new ValidationError(
        "relay",
        "Relay has no interactive card surface; provide fallbackText",
      );
    }
    return markdownToPlainText(rendered);
  }
  if ("raw" in message) return message.raw;
  if ("markdown" in message) {
    return markdownToPlainText(message.markdown);
  }
  if ("ast" in message) return toPlainText(message.ast);
  throw new ValidationError(
    "relay",
    "Unsupported Chat SDK postable message shape",
  );
}

export function hasPostableContent(
  message: AdapterPostableMessage,
): boolean {
  return (
    postableText(message).length > 0 ||
    extractPostableAttachments(message).length > 0 ||
    extractFiles(message).length > 0
  );
}

export function textParts(value: string): RelayOutgoingPart[] {
  if (!value) return [];
  const result: RelayOutgoingPart[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(
      offset + RELAY_MAX_TEXT_PART_LENGTH,
      value.length,
    );
    if (
      end < value.length &&
      /[\uD800-\uDBFF]/.test(value.charAt(end - 1))
    ) {
      end -= 1;
    }
    result.push({ type: "text", value: value.slice(offset, end) });
    offset = end;
  }
  return result;
}

/**
 * Read a postable body into bytes Relay can store.
 *
 * A Node `Buffer` is a view into a pooled `ArrayBuffer` that it usually does
 * not own outright, so the bytes are copied out of the pool. Handing
 * `buffer.buffer` straight to the uploader would post whatever else the pool
 * happened to be holding.
 */
async function uploadBody(
  data: unknown,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await toBuffer(data, TO_BUFFER_OPTIONS);
  if (!buffer) {
    throw new ValidationError(
      "relay",
      `Relay cannot read the bytes of ${label}; pass a Buffer, an `
        + "ArrayBuffer, or a Blob.",
    );
  }
  return new Uint8Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
  );
}

async function uploadedMediaPart(
  upload: RelayMediaUploader,
  options: {
    body: Uint8Array<ArrayBuffer>;
    contentType: string;
    filename: string;
    height?: number;
    width?: number;
  },
): Promise<RelayOutgoingPart> {
  const allocation = await upload(options);
  return { attachment_id: allocation.attachment_id, type: "media" };
}

async function attachmentPart(
  attachment: Attachment,
  upload: RelayMediaUploader,
): Promise<RelayOutgoingPart> {
  // A public URL is already storable by reference, so it costs no upload.
  if (attachment.url?.startsWith("https://")) {
    return { type: "media", url: attachment.url };
  }
  const filename = attachment.name ?? "attachment";
  const data = attachment.data ?? (await attachment.fetchData?.());
  if (data === undefined) {
    throw new ValidationError(
      "relay",
      `Attachment ${JSON.stringify(filename)} carries neither bytes nor a `
        + "public HTTPS URL.",
    );
  }
  return uploadedMediaPart(upload, {
    body: await uploadBody(data, `attachment ${JSON.stringify(filename)}`),
    contentType: contentTypeFor(filename, attachment.mimeType),
    filename,
    ...(attachment.height !== undefined
      ? { height: attachment.height }
      : {}),
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
  });
}

async function filePart(
  file: FileUpload,
  upload: RelayMediaUploader,
): Promise<RelayOutgoingPart> {
  return uploadedMediaPart(upload, {
    body: await uploadBody(
      file.data,
      `file ${JSON.stringify(file.filename)}`,
    ),
    contentType: contentTypeFor(file.filename, file.mimeType),
    filename: file.filename,
  });
}

/**
 * Turn a Chat SDK postable message into Relay message parts, allocating and
 * uploading any local bytes it carries.
 *
 * Uploads run before the send, so the send body names attachment IDs that
 * already exist. Inside an inbound webhook turn the send is keyed on the
 * event ID: a redelivery re-uploads, producing new attachment IDs and so a
 * different body under the same Idempotency-Key, which Relay refuses with
 * HTTP 409 rather than posting the message twice. A loud refusal on
 * redelivery is the safe end of that trade; a silent duplicate is not.
 */
export async function buildRelayParts(
  message: AdapterPostableMessage,
  upload: RelayMediaUploader,
): Promise<RelayOutgoingPart[]> {
  const parts = textParts(postableText(message));
  for (const attachment of extractPostableAttachments(message)) {
    parts.push(await attachmentPart(attachment, upload));
  }
  for (const file of extractFiles(message)) {
    parts.push(await filePart(file, upload));
  }
  if (parts.length > RELAY_MAX_MESSAGE_PARTS) {
    throw new ValidationError(
      "relay",
      `A Relay message supports at most ${RELAY_MAX_MESSAGE_PARTS} parts`,
    );
  }
  return parts;
}
