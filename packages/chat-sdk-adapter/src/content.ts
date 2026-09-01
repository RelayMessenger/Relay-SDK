import {
  cardToFallbackText,
  extractCard,
  extractFiles,
  extractPostableAttachments,
  ValidationError,
} from "@chat-adapter/shared";
import {
  markdownToPlainText,
  toPlainText,
  type AdapterPostableMessage,
  type Attachment,
} from "chat";
import type { RelayOutgoingPart } from "./types.js";

export const RELAY_MAX_TEXT_PART_LENGTH = 10_000;
export const RELAY_MAX_MESSAGE_PARTS = 100;
export const RELAY_MAX_ATTACHMENT_BYTES = 104_857_600;

const SUPPORTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "image/webp",
  "image/x-icon",
  "video/mp4",
  "video/quicktime",
  "video/mpeg",
  "video/mpeg2",
  "video/x-m4v",
  "video/x-msvideo",
  "video/3gpp",
  "audio/mpeg",
  "audio/mp3",
  "audio/x-m4a",
  "audio/mp4",
  "audio/x-caf",
  "audio/x-wav",
  "audio/x-aiff",
  "audio/aiff",
  "audio/aac",
  "audio/midi",
  "audio/amr",
  "application/pdf",
  "application/vnd.apple.pkpass",
  "text/plain",
  "text/markdown",
  "text/vcard",
  "text/rtf",
  "text/csv",
  "text/html",
  "text/calendar",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-iwork-pages-sffpages",
  "application/x-iwork-numbers-sffnumbers",
  "application/x-iwork-keynote-sffkey",
  "application/epub+zip",
  "text/xml",
  "application/json",
  "application/zip",
  "application/x-gzip",
]);

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
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const contentType =
    normalized || (extension ? MIME_BY_EXTENSION[extension] : undefined);
  if (!contentType || !SUPPORTED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(
      "relay",
      `Relay does not accept the content type for ${JSON.stringify(
        filename,
      )}; pass one of the content types in the v1 SupportedContentType contract`,
    );
  }
  return contentType;
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

async function attachmentPart(
  attachment: Attachment,
): Promise<RelayOutgoingPart> {
  if (attachment.url?.startsWith("https://")) {
    return { type: "media", url: attachment.url };
  }
  throw new ValidationError(
    "relay",
    `Attachment ${JSON.stringify(
      attachment.name ?? "(unnamed)",
    )} needs a public HTTPS URL. Allocate and upload retryable bytes with `
      + "@relaymessenger/sdk before posting through Chat SDK.",
  );
}

export async function buildRelayParts(
  message: AdapterPostableMessage,
): Promise<RelayOutgoingPart[]> {
  const parts = textParts(postableText(message));
  for (const attachment of extractPostableAttachments(message)) {
    parts.push(await attachmentPart(attachment));
  }
  for (const file of extractFiles(message)) {
    throw new ValidationError(
      "relay",
      `File ${JSON.stringify(file.filename)} needs a public HTTPS URL. `
        + "Allocate and upload retryable bytes with @relaymessenger/sdk before "
        + "posting through Chat SDK.",
    );
  }
  if (parts.length > RELAY_MAX_MESSAGE_PARTS) {
    throw new ValidationError(
      "relay",
      `A Relay message supports at most ${RELAY_MAX_MESSAGE_PARTS} parts`,
    );
  }
  return parts;
}
