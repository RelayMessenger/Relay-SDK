import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { selectionPart } from "@relaymessenger/sdk";
import { SELECTION_TOOL_SCHEMA } from "../src/selection-schema.ts";

// Claude Code validates a tool call against the tool's inputSchema before the
// channel sees it, so every field SELECTION_GUIDANCE asks for must pass here.
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats is CommonJS: its plugin is the module's default export.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validate = ajv.compile(SELECTION_TOOL_SCHEMA);

const listPicker = {
  title: "Pick a time",
  subtitle: "Times are in your time zone",
  multiple: false,
  sections: [
    { title: "Wednesday", options: [{ id: "wed-9", label: "Wed 9:00 AM", subtitle: "30 minutes", image_url: "https://example.com/a.png" }] },
    { title: "Thursday", options: [{ id: "thu-9", label: "Thu 9:00 AM" }] },
  ],
  reply_message: { title: "Your time", subtitle: "We will text you a reminder" },
};

describe("reply tool selection schema", () => {
  it("accepts a list picker with sections, ids, subtitles, images, multiple and reply_message", () => {
    expect(validate(listPicker), JSON.stringify(validate.errors)).toBe(true);
    expect(typeof selectionPart(listPicker)).toBe("object");
  });

  it("accepts flat options with ids, and the legacy value-only shape", () => {
    const flat = { title: "Toppings", options: [{ id: "cheese", label: "Cheese", subtitle: "" }] };
    const legacy = { title: "Toppings", options: [{ value: "cheese", label: "Cheese" }] };
    for (const call of [flat, legacy]) {
      expect(validate(call), JSON.stringify(validate.errors)).toBe(true);
      expect(typeof selectionPart(call)).toBe("object");
    }
  });

  it("refuses what the contract refuses", () => {
    for (const call of [
      { options: [{ id: "a", label: "A" }] },
      { title: "   ", options: [{ id: "a", label: "A" }] },
      { title: "Q", options: [{ id: "a", label: "A", image_url: "http://example.com/a.png" }] },
      { title: "Q", options: [{ id: "a", label: "A", icon: "star" }] },
      { title: "Q", options: [{ id: "a", label: "A" }], expires_at: "2026-10-01" },
      { title: "Q", sections: [{ title: "S".repeat(25), options: [{ id: "a", label: "A" }] }] },
      { title: "Q", options: [{ id: "a", label: "A" }], reply_message: { subtitle: "x" } },
    ]) {
      expect(validate(call), JSON.stringify(call)).toBe(false);
    }
  });
});
