import { readFileSync } from "node:fs";
import {
  buttonsPart,
  formPart,
  selectionPart,
  type ButtonItem,
  type CarouselPart,
  type MessageContent,
  type MessagePart,
  type PlacePart,
  type RichCardPart,
  type TextPart,
} from "@relaymessenger/sdk";
import { InvalidArgumentError, type Command } from "commander";

/**
 * The message flags every send command shares: each part the contract lets a
 * sender write (MessageContent in contracts/relay-v1-openapi.yaml), from flags
 * for the small ones and from JSON for the ones with structure.
 */
export interface MessagePartOptions {
  text?: string;
  mention?: string;
  media?: string[];
  link?: string;
  button?: string[];
  selection?: string;
  form?: string;
  richCard?: string;
  carousel?: string;
  place?: string;
  placeName?: string;
  placeAddress?: string;
  payment?: string;
  parts?: string;
  replyTo?: string;
  replyPartIndex?: number;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const partIndex = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new InvalidArgumentError("Expected a non-negative integer.");
  return parsed;
};

/** Adds the shared message flags to a send command. `--text` stays the first. */
export const messagePartOptions = (command: Command): Command => command
  .option("--text <text>", "the text to send")
  .option("--mention <handle>", "mention this @handle written in --text")
  .option("--media <url-or-attachment-id>", "an https file URL or attachment ID", collect)
  .option("--link <url>", "a link with its preview, sent alone")
  .option("--button <label>", "a reply button, or label=https://url", collect)
  .option("--selection <json-or-file>", "a list picker, as JSON")
  .option("--form <json-or-file>", "a form, as JSON")
  .option("--rich-card <json-or-file>", "a rich card, as JSON")
  .option("--carousel <json-or-file>", "a carousel of cards, as JSON")
  .option("--place <latitude,longitude>", "a place on the map")
  .option("--place-name <name>", "the place's name")
  .option("--place-address <address>", "the place's address")
  .option("--payment <checkout-url>", "a payment request's checkout URL, sent alone")
  .option("--parts <json-or-file>", "every part as a JSON array")
  .option("--reply-to <message-id>", "reply to this message")
  .option("--reply-part-index <number>", "reply to this part, counting from zero", partIndex);

/** Inline JSON when it starts with `{` or `[`; otherwise the path of a JSON file. */
const json = (flag: string, value: string): unknown => {
  const trimmed = value.trim();
  let source = trimmed;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    try {
      source = readFileSync(trimmed, "utf8").replace(/^﻿/u, "");
    } catch {
      throw new Error(`${flag} must be JSON or the path of a JSON file; ${trimmed} could not be read.`);
    }
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${flag} is not valid JSON.`);
  }
};

const object = (flag: string, value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${flag} must be a JSON object.`);
  return value as Record<string, unknown>;
};

const typed = <T extends MessagePart>(flag: string, type: T["type"], value: unknown): T => {
  const part = object(flag, value);
  if (part.type !== undefined && part.type !== type) throw new Error(`${flag} must be a ${type} part.`);
  return { ...part, type } as T;
};

const checked = <T>(flag: string, result: T | string): T => {
  if (typeof result === "string") throw new Error(`${flag}: ${result}.`);
  return result;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const button = (value: string): ButtonItem => {
  const at = value.search(/=https?:\/\//u);
  const label = (at < 0 ? value : value.slice(0, at)).trim();
  if (!label) throw new Error("--button needs a label.");
  return at < 0 ? { label } : { label, url: value.slice(at + 1).trim() };
};

const place = (options: MessagePartOptions): PlacePart => {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(options.place!);
  if (!match) throw new Error("--place must be latitude,longitude, for example 37.4422,-122.1615.");
  return {
    type: "place",
    latitude: Number(match[1]),
    longitude: Number(match[2]),
    ...(options.placeName === undefined ? {} : { name: options.placeName }),
    ...(options.placeAddress === undefined ? {} : { address: options.placeAddress }),
  };
};

const textPart = (text: string, mention: string | undefined): TextPart => {
  const value = text.trim();
  if (!value) throw new Error("Message text cannot be empty.");
  if (mention === undefined) return { type: "text", value };
  const handle = mention.trim().replace(/^@/u, "");
  const written = `@${handle}`;
  // UTF-16 code units, the unit the contract measures mention ranges in.
  const start = value.indexOf(written);
  if (!handle || start < 0) throw new Error(`Write ${written} in --text to mention it.`);
  return { type: "text", value, mention: handle, mention_range: [start, start + written.length] };
};

const PART_FLAGS = [
  "text", "media", "link", "button", "selection", "form", "richCard", "carousel", "place", "payment",
] as const;

/**
 * Builds the message a send command carries. The order is the order a person
 * reads: text first, then media, then the one interactive or rich part. The
 * server keeps the combination rules (a link or a payment is the only part; at
 * most one card or carousel); this only refuses what cannot be a message.
 */
export const messageContent = (
  options: MessagePartOptions,
  idempotencyKey?: string,
  silent?: boolean,
): MessageContent => {
  if (options.mention !== undefined && options.text === undefined) throw new Error("--mention needs --text.");
  if ((options.placeName !== undefined || options.placeAddress !== undefined) && options.place === undefined) {
    throw new Error("--place-name and --place-address need --place.");
  }
  if (options.replyPartIndex !== undefined && options.replyTo === undefined) throw new Error("--reply-part-index needs --reply-to.");
  let parts: MessagePart[];
  if (options.parts !== undefined) {
    const used = PART_FLAGS.filter((flag) => options[flag] !== undefined);
    if (used.length) throw new Error("--parts carries every part; leave out the other part flags.");
    const value = json("--parts", options.parts);
    const list = Array.isArray(value) ? value : object("--parts", value).parts;
    if (!Array.isArray(list) || list.length === 0) throw new Error("--parts must be a non-empty JSON array of parts.");
    parts = list.map((part, index) => object(`--parts item ${index}`, part)) as unknown as MessagePart[];
  } else {
    parts = [
      ...(options.text === undefined ? [] : [textPart(options.text, options.mention)]),
      ...(options.media ?? []).map((media): MessagePart => {
        const value = media.trim();
        return UUID.test(value) ? { type: "media", attachment_id: value } : { type: "media", url: value };
      }),
      ...(options.link === undefined ? [] : [{ type: "link", value: options.link.trim() } as const]),
      ...(options.button === undefined ? [] : [checked("--button", buttonsPart(options.button.map(button)))]),
      ...(options.selection === undefined ? [] : [checked("--selection", selectionPart(json("--selection", options.selection)))]),
      ...(options.form === undefined ? [] : [checked("--form", formPart(json("--form", options.form)))]),
      ...(options.richCard === undefined ? [] : [typed<RichCardPart>("--rich-card", "rich_card", json("--rich-card", options.richCard))]),
      ...(options.carousel === undefined ? [] : [typed<CarouselPart>("--carousel", "carousel", json("--carousel", options.carousel))]),
      ...(options.place === undefined ? [] : [place(options)]),
      ...(options.payment === undefined ? [] : [{ type: "payment", checkout_url: options.payment.trim() } as const]),
    ];
  }
  if (parts.length === 0) {
    throw new Error("Nothing to send. Pass --text, a part flag such as --media or --button, or --parts.");
  }
  return {
    parts,
    ...(options.replyTo === undefined
      ? {}
      : { reply_to: { message_id: options.replyTo.trim(), ...(options.replyPartIndex === undefined ? {} : { part_index: options.replyPartIndex }) } }),
    ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey.trim() }),
    ...(silent ? { silent: true } : {}),
  };
};
