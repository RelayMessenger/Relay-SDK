import type { FormAnswers, FormField, FormPart, MessagePartResponse, ReplyTo, TextPart } from "./types.js";

export const FORM_FENCE = "form";
export const FORM_GUIDANCE =
  "Use form for several fields across ordered pages. Give each page and field an explicit stable id. "
  + "Fields are text (single-line or multiline), select (single or multiple), picker, or date (YYYY-MM-DD). "
  + "Text max_length defaults to 30 single-line or 300 multiline; a positive explicit value overrides it. "
  + "Use show_summary for an optional review page. Put any extra words in an optional text part above the card. "
  + "Send one form, never with buttons or selection. Only the user answers, once. "
  + "The reply contains plain text 'Form sent' and form_response.answers keyed by field id, "
  + "with reply_to naming the source part. Dispatch on those ids, never on labels or visible text.";
export const FORM_BLOCK_INSTRUCTION =
  "To collect several answers, end your answer with a fenced code block tagged `form` "
  + 'containing {"title":"Details","pages":[{"id":"details","title":"Details","fields":'
  + '[{"id":"name","type":"text","label":"Name","required":true}]}]}. '
  + "Words outside the block are sent as a normal message above the card.";

const object = (value: unknown, allowed: readonly string[], name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} needs an object`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`${name} has unknown field ${extra}`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number, name: string, trim = true): string => {
  if (typeof value !== "string") throw new Error(`${name} needs a string`);
  const result = trim ? value.trim() : value;
  if ((trim && !result) || [...result].length > max) throw new Error(`${name} exceeds its character limit or is blank`);
  return result;
};
const token = (value: unknown, max: number, name: string): string => {
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new Error(`${name} needs an ASCII token of 1 to ${max} characters`);
  }
  return value;
};
const list = (value: unknown, max: number, name: string): unknown[] => {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`${name} has an invalid item count`);
  return value;
};
const unique = (seen: Set<string>, id: string, name: string): void => {
  if (seen.has(id)) throw new Error(`duplicate ${name} ${id}`);
  seen.add(id);
};
const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${name} needs a boolean`);
  return value;
};

const fieldPart = (value: unknown, ids: Set<string>): FormField => {
  const common = ["id", "type", "label", "placeholder", "required", "max_length"];
  const raw = object(value, [...common, "multiline", "multiple", "options"], "field");
  const kind = raw.type;
  if (kind !== "text" && kind !== "select" && kind !== "picker" && kind !== "date") throw new Error("unknown form field type");
  object(raw, [...common, ...(kind === "text" ? ["multiline"] : kind === "select" ? ["multiple", "options"] : kind === "picker" ? ["options"] : [])], "field");
  const id = token(raw.id, 100, "field id");
  unique(ids, id, "field id");
  const field: Record<string, unknown> = {
    id, type: kind, label: text(raw.label, kind === "date" ? 40 : kind === "select" ? 30 : 20, "field label"),
  };
  if (raw.placeholder !== undefined) field.placeholder = text(raw.placeholder, Infinity, "placeholder", false);
  if (raw.required !== undefined) field.required = boolean(raw.required, "required");
  if (raw.max_length !== undefined) {
    if (!Number.isSafeInteger(raw.max_length) || (raw.max_length as number) < (kind === "date" ? 10 : 1)) {
      throw new Error("max_length needs a positive integer (at least 10 for date)");
    }
    field.max_length = raw.max_length;
  }
  if (kind === "text" && raw.multiline !== undefined) field.multiline = boolean(raw.multiline, "multiline");
  if (kind === "select" && raw.multiple !== undefined) field.multiple = boolean(raw.multiple, "multiple");
  if (kind === "select" || kind === "picker") {
    const seen = new Set<string>();
    field.options = list(raw.options, kind === "select" ? 20 : 200, "options").map((entry) => {
      const option = object(entry, ["value", "label"], "option");
      const optionValue = token(option.value, 100, "option value");
      unique(seen, optionValue, "option value");
      if (optionValue.length > (raw.max_length as number | undefined ?? 100)) throw new Error("max_length must fit every option value");
      return { value: optionValue, label: text(option.label, 30, "option label") };
    });
  }
  return field as unknown as FormField;
};

/** Validate and copy a request definition; never accept viewer-only state. */
export const formPart = (value: unknown): FormPart | string => {
  try {
    const raw = object(value, ["type", "title", "pages", "show_summary", "splash", "received_message", "reply_message"], "form");
    if (raw.type !== undefined && raw.type !== "form") throw new Error("form part needs type form");
    const pageIds = new Set<string>();
    const fieldIds = new Set<string>();
    const result: FormPart = {
      type: "form", title: text(raw.title, 80, "form title"),
      pages: list(raw.pages, Infinity, "pages").map((entry) => {
        const page = object(entry, ["id", "title", "fields"], "page");
        const id = token(page.id, 19, "page id");
        unique(pageIds, id, "page id");
        return { id, title: text(page.title, 80, "page title"), fields: list(page.fields, 50, "fields").map((field) => fieldPart(field, fieldIds)) };
      }),
    };
    if (raw.show_summary !== undefined) result.show_summary = boolean(raw.show_summary, "show_summary");
    if (raw.splash !== undefined) {
      const splash = object(raw.splash, ["title", "text", "button_title"], "splash");
      result.splash = {
        button_title: text(splash.button_title, 35, "splash button title"),
        ...(splash.title === undefined ? {} : { title: text(splash.title, 80, "splash title") }),
        ...(splash.text === undefined ? {} : { text: text(splash.text, 4096, "splash text", false) }),
      };
    }
    if (raw.received_message !== undefined) {
      const message = object(raw.received_message, ["title", "subtitle"], "received_message");
      result.received_message = {
        title: text(message.title, 512, "received title"),
        ...(message.subtitle === undefined ? {} : { subtitle: text(message.subtitle, 512, "received subtitle", false) }),
      };
    }
    if (raw.reply_message !== undefined) {
      const message = object(raw.reply_message, ["title", "subtitle"], "reply_message");
      if (message.title !== "Form sent") throw new Error("reply_message title must be Form sent");
      result.reply_message = {
        title: "Form sent",
        ...(message.subtitle === undefined ? {} : { subtitle: text(message.subtitle, 512, "reply subtitle", false) }),
      };
    }
    return result;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
};

export const partsWithForm = (text: string | undefined, form: FormPart): [TextPart, FormPart] | [FormPart] => {
  const validated = formPart(form);
  if (typeof validated === "string") throw new Error(validated);
  return text?.trim() ? [{ type: "text", value: text }, validated] : [validated];
};

export const parseFormBlock = (body: string): FormPart | string => {
  try { return formPart(JSON.parse(body)); }
  catch { return "the form block is not valid JSON"; }
};

export interface SplitForm {
  text: string;
  form?: FormPart;
  error?: string;
}

export const splitForm = (answer: string): SplitForm => {
  const fence = /(^|\n)[ \t]*```[ \t]*form(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/gu;
  const matches = [...answer.matchAll(fence)];
  if (!matches.length) return { text: answer };
  if (matches.length !== 1 || /(^|\n)[ \t]*```[ \t]*(?:buttons|selection|payment)(?:[ \t][^\r\n]*)?\r?\n/u.test(answer)) {
    return { text: answer, error: "send one form and no other interactive blocks in the same message" };
  }
  const match = matches[0]!;
  const form = parseFormBlock(match[2] ?? "");
  if (typeof form === "string") return { text: answer, error: form };
  const text = [answer.slice(0, match.index).trimEnd(), answer.slice(match.index + match[0].length).trimStart()].filter(Boolean).join("\n\n");
  return { text, form };
};

export interface FormReply {
  answers: FormAnswers;
  reply_to: ReplyTo & { part_index: number };
}

/** Discover server-validated response data, without parsing visible text. */
export const formReply = (parts: readonly MessagePartResponse[], replyTo?: ReplyTo | null): FormReply | undefined => {
  const response = parts.find((part) => part.type === "form_response");
  if (!response || !replyTo?.message_id || !Number.isInteger(replyTo.part_index) || replyTo.part_index! < 0) return undefined;
  return {
    answers: Object.fromEntries(Object.entries(response.answers).map(([id, value]) => [id, Array.isArray(value) ? [...value] : value])),
    reply_to: { message_id: replyTo.message_id, part_index: replyTo.part_index! },
  };
};
