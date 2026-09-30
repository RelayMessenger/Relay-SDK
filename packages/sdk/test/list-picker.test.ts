import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answerMessages, parseSelectionBlock, partsWithSelection, selectionPart, selectionReply } from "../src/index.js";
import type { MessagePartResponse } from "../src/index.js";
const fixtures = JSON.parse(readFileSync(new URL("../../../test/fixtures/list-picker.json", import.meta.url), "utf8"));
describe("list picker wire cases", () => {
  it.each(fixtures.valid)("$name", ({ input, expected }) => {
    expect(selectionPart(input)).toEqual(expected);
    expect(parseSelectionBlock(JSON.stringify(input))).toEqual(expected);
    expect(partsWithSelection(undefined, expected)).toEqual([expected]);
    expect(answerMessages("```selection\n" + JSON.stringify(input) + "\n```")).toEqual({ messages: [[expected]] });
  });
  it.each(fixtures.invalid)("rejects $name", ({ input }) => {
    expect(typeof selectionPart(input)).toBe("string");
  });
  it("discovers IDs and source-owned reply text without deriving from labels", () => {
    const source = { message_id: "source", part_index: 0 };
    const metadata = { type: "selection_response", selected_values: ["a / 1"], selected_ids: ["a / 1"], reply_message: { title: "Saved", subtitle: "Thanks" } };
    const parts = [{ type: "text", value: "• Same" }, metadata] as MessagePartResponse[];
    const result = selectionReply(parts, source);
    expect(result).toEqual({ selected_values: ["a / 1"], selected_ids: ["a / 1"], reply_message: { title: "Saved", subtitle: "Thanks" }, reply_to: source });
    result!.selected_ids!.push("local");
    result!.reply_message!.title = "local";
    expect(metadata.selected_ids).toEqual(["a / 1"]);
    expect(metadata.reply_message.title).toBe("Saved");
  });
});

describe("list picker guidance matches the contract", () => {
  it("states the single-choice rule and the 24-character label for rows with an id", async () => {
    const { SELECTION_GUIDANCE } = await import("../src/selection.js");
    expect(SELECTION_GUIDANCE).toContain("with `multiple: false` the person checks exactly one");
    expect(SELECTION_GUIDANCE).toContain("a `label` of 1 to 24 characters");
    expect(SELECTION_GUIDANCE).toContain("`label` is 1 to 80 characters; if a row has both id and value they must match");
    expect(SELECTION_GUIDANCE).not.toContain("checks any number of options and submits them once");
    expect(SELECTION_GUIDANCE).not.toContain("Labels are trimmed, 1 to 80 characters");
  });
});

