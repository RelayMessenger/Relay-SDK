import { ValidationError } from "@chat-adapter/shared";
import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  postableText,
  textParts,
} from "../src/content.js";
import { RELAY_MAX_TEXT_PART_LENGTH } from "../src/index.js";

describe("Relay message content", () => {
  it("flattens Markdown because Relay text is plain text", () => {
    expect(
      postableText({
        markdown: "**bold** and [Relay](https://relayapp.im)",
      }),
    ).toBe("bold and Relay");
  });

  it("chunks at the locked 10,000 UTF-16-unit part limit", () => {
    const value = `${"a".repeat(
      RELAY_MAX_TEXT_PART_LENGTH - 1,
    )}😀tail`;
    const parts = textParts(value);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: "text",
      value: "a".repeat(RELAY_MAX_TEXT_PART_LENGTH - 1),
    });
    expect(parts[1]).toMatchObject({ value: "😀tail" });
    expect(
      parts
        .map((part) => ("value" in part ? part.value : ""))
        .join(""),
    ).toBe(value);
  });

  it("infers only content types accepted by the contract", () => {
    expect(contentTypeFor("report.pdf")).toBe("application/pdf");
    expect(() => contentTypeFor("binary.bin")).toThrow(
      ValidationError,
    );
  });
});
