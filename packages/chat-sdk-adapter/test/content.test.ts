import { ValidationError } from "@chat-adapter/shared";
import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  postableText,
  RELAY_FALLBACK_CONTENT_TYPE,
  RELAY_MAX_CONTENT_TYPE_LENGTH,
  textParts,
  buildRelayParts,
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

  it("infers a known content type from the filename extension", () => {
    expect(contentTypeFor("report.pdf")).toBe("application/pdf");
  });

  it("passes any well-formed content type through unchanged", () => {
    expect(contentTypeFor("payload.custom", "application/x-custom")).toBe(
      "application/x-custom",
    );
    expect(
      contentTypeFor("Model.USDZ", "Model/VND.USDZ+ZIP; charset=binary"),
    ).toBe("model/vnd.usdz+zip");
  });

  it("falls back to application/octet-stream for an unknown extension", () => {
    expect(contentTypeFor("binary.bin")).toBe(
      RELAY_FALLBACK_CONTENT_TYPE,
    );
    expect(RELAY_FALLBACK_CONTENT_TYPE).toBe("application/octet-stream");
  });

  it("rejects a malformed content type with the Relay ValidationError", () => {
    for (
      const declared of [
        "application",
        "application/",
        "/x-custom",
        "application/x custom",
        "application/x/custom",
        "application/x\u0000custom",
        `application/${"x".repeat(RELAY_MAX_CONTENT_TYPE_LENGTH)}`,
      ]
    ) {
      expect(() => contentTypeFor("payload.bin", declared)).toThrow(
        ValidationError,
      );
    }
  });
});

describe("a message that is only a URL", () => {
  it("goes out as a link part so the reader sees a card", async () => {
    const upload = async () => { throw new Error("no upload expected"); };
    expect(await buildRelayParts({ markdown: "https://example.com/story" }, upload as never)).toEqual([
      { type: "link", value: "https://example.com/story" },
    ]);
    expect(await buildRelayParts({ markdown: "Read https://example.com/story today" }, upload as never)).toEqual([
      { type: "text", value: "Read https://example.com/story today" },
    ]);
  });
});
