import { SELECTION_GUIDANCE } from "@relaymessenger/sdk";

// The reply tool's `selection` argument: Relay's SelectionPart without its
// `type`, so every field SELECTION_GUIDANCE tells the model to send is
// accepted here (the channel then checks it with the SDK's selectionPart).
// Rules plain JSON Schema keywords do not carry (exactly one of options or
// sections, 24-character labels on rows with an id, matching id and value)
// are in the descriptions and enforced by selectionPart before anything is sent.
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength, pattern: "\\S" });

const option = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  description: "One row. Give id (returned in selected_ids), or the legacy value. If both are given they must match.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    value: { type: "string", minLength: 1, maxLength: 200, description: "Legacy alias for id. Without id, 1 to 100 characters matching ^[A-Za-z0-9][A-Za-z0-9._:-]*$." },
    label: { ...text(80), description: "1 to 24 characters when id is given; 1 to 80 for a legacy value-only row." },
    subtitle: { type: "string", maxLength: 72 },
    image_url: { type: "string", format: "uri", pattern: "^https://", maxLength: 2048 },
  },
};

const options = { type: "array", minItems: 1, maxItems: 25, items: option };

export const SELECTION_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  description: `Choices submitted together. Give exactly one of options or sections. Text is optional; not with buttons or link. ${SELECTION_GUIDANCE}`,
  properties: {
    title: text(60),
    subtitle: { type: "string", maxLength: 512 },
    multiple: { type: "boolean", default: true },
    options,
    sections: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "Titled groups in order, at most 25 rows across all of them.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "options"],
        properties: { title: text(24), options },
      },
    },
    reply_message: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      description: "The answered bubble's title and subtitle.",
      properties: { title: text(512), subtitle: { type: "string", maxLength: 512 } },
    },
  },
} as const;
