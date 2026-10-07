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
  type CardChild,
  type CardElement,
  type FileUpload,
} from "chat";
import type {
  RelayCardContent,
  RelayCarouselPart,
  RelayOutgoingPart,
  RelayRichCardPart,
  RelayRichCardSuggestion,
} from "./types.js";

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

/** Relay's card limits (Relay-Server `rich-cards.ts`, `@relaymessenger/sdk` RICH_CARD_*). */
export const RELAY_CARD_TITLE_MAX_LENGTH = 200;
export const RELAY_CARD_DESCRIPTION_MAX_LENGTH = 2_000;
export const RELAY_CARD_MAX_SUGGESTIONS = 4;
export const RELAY_SUGGESTION_LABEL_MAX_LENGTH = 25;
export const RELAY_SUGGESTION_ID_MAX_LENGTH = 256;
export const RELAY_CAROUSEL_MIN_CARDS = 2;
export const RELAY_CAROUSEL_MAX_CARDS = 10;

/**
 * The reply id a Chat SDK Button travels as, in the codec the official
 * WhatsApp and Telegram adapters use (`chat:` + `{"a": id, "v": value}`), so
 * a tap comes back as the Button's `actionId` and `value` and reaches
 * `chat.onAction`, as https://chat-sdk.dev/docs/actions documents.
 */
export const RELAY_ACTION_ID_PREFIX = "chat:";

export function encodeRelayActionId(actionId: string, value?: string): string {
  return `${RELAY_ACTION_ID_PREFIX}${JSON.stringify(value === undefined ? { a: actionId } : { a: actionId, v: value })}`;
}

/**
 * The Button behind a reply id, or undefined for an id this adapter did not
 * encode: a native Relay card's reply, which stays an ordinary message.
 */
export function decodeRelayActionId(
  id: string,
): { actionId: string; value?: string } | undefined {
  if (!id.startsWith(RELAY_ACTION_ID_PREFIX)) return undefined;
  try {
    const decoded = JSON.parse(id.slice(RELAY_ACTION_ID_PREFIX.length)) as { a?: unknown; v?: unknown };
    if (typeof decoded.a !== "string" || !decoded.a) return undefined;
    return typeof decoded.v === "string" ? { actionId: decoded.a, value: decoded.v } : { actionId: decoded.a };
  } catch {
    return undefined;
  }
}

/** Relay counts card limits in Unicode code points, not UTF-16 units. */
const codePoints = (value: string): number => [...value].length;

/**
 * A Chat SDK Card as one Relay card, or the reason it cannot be one.
 *
 * The header image (or one Image child) becomes the card's picture, the title
 * its title, and the subtitle with every Text, Fields, Link and Section child
 * its description, as plain text. A Button becomes a reply suggestion carrying
 * its id and value (`encodeRelayActionId`), and a LinkButton an `open_url`
 * suggestion. What a
 * Relay card cannot draw (a select, a table, a chart, a second image, more
 * than four buttons, a label over 25 characters) leaves the card as text.
 */
function cardContent(card: CardElement): RelayCardContent | string {
  const images: string[] = card.imageUrl ? [card.imageUrl] : [];
  const lines: string[] = card.subtitle?.trim() ? [card.subtitle.trim()] : [];
  const suggestions: RelayRichCardSuggestion[] = [];
  const visit = (children: readonly CardChild[]): string | undefined => {
    for (const child of children) {
      switch (child.type) {
        case "text": {
          const value = markdownToPlainText(child.content).trim();
          if (value) lines.push(value);
          break;
        }
        case "image":
          images.push(child.url);
          break;
        case "divider":
          break;
        case "fields":
          for (const field of child.children) lines.push(`${field.label}: ${field.value}`);
          break;
        case "link":
          lines.push(`${child.label}: ${child.url}`);
          break;
        case "section": {
          const problem = visit(child.children);
          if (problem) return problem;
          break;
        }
        case "actions":
          for (const action of child.children) {
            if (action.type === "button") {
              if (action.disabled || action.actionType === "modal") return `button ${action.id} is ${action.disabled ? "disabled" : "a modal button"}`;
              suggestions.push({ type: "reply", label: action.label, id: encodeRelayActionId(action.id, action.value) });
            } else if (action.type === "link-button") {
              suggestions.push({ type: "open_url", label: action.label, url: action.url });
            } else {
              return `a ${action.type} element`;
            }
          }
          break;
        default:
          return `a ${child.type} element`;
      }
    }
    return undefined;
  };
  const problem = visit(card.children);
  if (problem) return problem;
  if (images.length > 1) return "more than one image";
  if (images[0] && !images[0].startsWith("https://")) return "an image that is not a public https URL";
  const title = card.title?.trim();
  const description = lines.join("\n");
  if (title && codePoints(title) > RELAY_CARD_TITLE_MAX_LENGTH) return "a title over 200 characters";
  if (codePoints(description) > RELAY_CARD_DESCRIPTION_MAX_LENGTH) return "text over 2,000 characters";
  if (suggestions.length > RELAY_CARD_MAX_SUGGESTIONS) return "more than four buttons";
  for (const suggestion of suggestions) {
    const label = codePoints(suggestion.label);
    if (label < 1 || label > RELAY_SUGGESTION_LABEL_MAX_LENGTH) return `button label ${JSON.stringify(suggestion.label)}`;
    // The adapter guide (https://chat-sdk.dev/docs/contributing/building):
    // an encoded action over the platform's limit throws, never truncates.
    if (suggestion.type === "reply" && codePoints(suggestion.id) > RELAY_SUGGESTION_ID_MAX_LENGTH) {
      throw new ValidationError(
        "relay",
        `Button ${JSON.stringify(decodeRelayActionId(suggestion.id)?.actionId ?? suggestion.id)} with its value is over Relay's `
          + `${RELAY_SUGGESTION_ID_MAX_LENGTH}-character reply id limit; shorten the id or value`,
      );
    }
  }
  if (!images[0] && !title && !description) return "no picture, title or text";
  return {
    ...(images[0] ? { media: { type: "image" as const, url: images[0] } } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(suggestions.length ? { suggestions } : {}),
  };
}

function replyIds(cards: readonly RelayCardContent[]): string | undefined {
  const seen = new Set<string>();
  for (const card of cards) {
    for (const suggestion of card.suggestions ?? []) {
      if (suggestion.type !== "reply") continue;
      if (seen.has(suggestion.id)) return suggestion.id;
      seen.add(suggestion.id);
    }
  }
  return undefined;
}

/**
 * The Relay `rich_card` part for a Chat SDK Card, or undefined when the card
 * holds something a Relay card cannot draw; such a card is sent as text.
 */
export function toRelayRichCard(card: CardElement): RelayRichCardPart | undefined {
  const content = cardContent(card);
  if (typeof content === "string" || replyIds([content])) return undefined;
  return { type: "rich_card", ...content };
}


/**
 * A Relay `carousel` part from 2 to 10 Chat SDK Cards, swiped sideways.
 * Throws when a card cannot be a Relay card or two buttons share an id, since
 * a carousel has no text form to fall back to. Send it with
 * `adapter.postMessageParts(threadId, [part])`.
 */
export function toRelayCarousel(
  cards: readonly CardElement[],
  options: { cardWidth?: RelayCarouselPart["card_width"] } = {},
): RelayCarouselPart {
  if (cards.length < RELAY_CAROUSEL_MIN_CARDS || cards.length > RELAY_CAROUSEL_MAX_CARDS) {
    throw new ValidationError("relay", `A Relay carousel holds ${RELAY_CAROUSEL_MIN_CARDS} to ${RELAY_CAROUSEL_MAX_CARDS} cards, not ${cards.length}`);
  }
  const contents = cards.map((card, index) => {
    const content = cardContent(card);
    if (typeof content === "string") {
      throw new ValidationError("relay", `Card ${index + 1} cannot be a Relay card: it has ${content}`);
    }
    return content;
  });
  const duplicate = replyIds(contents);
  if (duplicate !== undefined) {
    throw new ValidationError("relay", `Button id ${JSON.stringify(duplicate)} is on more than one card; a carousel needs unique ids`);
  }
  return {
    type: "carousel",
    ...(options.cardWidth ? { card_width: options.cardWidth } : {}),
    cards: contents,
  };
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
        "This card holds something a Relay card cannot draw and has no text; provide fallbackText",
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
  const card = typeof message === "string" ? null : extractCard(message);
  return (
    (card ? toRelayRichCard(card) !== undefined : false) ||
    postableText(message).length > 0 ||
    extractPostableAttachments(message).length > 0 ||
    extractFiles(message).length > 0
  );
}

/** The server's limit for a link part's URL. */
export const RELAY_MAX_LINK_LENGTH = 2_048;

/**
 * The URL a message carries when its whole text is one absolute HTTP or HTTPS
 * URL, the way the Relay app itself turns such a draft into a `link` part so
 * the reader sees a card; otherwise undefined, and the words go as text.
 */
export function standaloneLinkText(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/iu.test(trimmed) || trimmed.length > RELAY_MAX_LINK_LENGTH) return undefined;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
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
  const card = typeof message === "string" ? null : extractCard(message);
  const richCard = card ? toRelayRichCard(card) : undefined;
  const text = richCard ? "" : postableText(message);
  const link = standaloneLinkText(text);
  if (
    link !== undefined
    && extractPostableAttachments(message).length === 0
    && extractFiles(message).length === 0
  ) {
    return [{ type: "link", value: link }];
  }
  const parts: RelayOutgoingPart[] = richCard ? [richCard] : textParts(text);
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
