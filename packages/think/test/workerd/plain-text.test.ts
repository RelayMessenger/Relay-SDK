// The Markdown parser runs inside workerd, where its browser build (which
// decodes entities through the DOM) would fail.
import { describe, expect, it } from "vitest";

import { plainChatText } from "../../src/plain-text.js";

describe("plainChatText in workerd", () => {
  it("turns block Markdown into plain lines", () => {
    expect(plainChatText("### Plan &amp; notes\n- **pack** light\n- leave at 9"))
      .toBe("Plan &amp; notes\n**pack** light\nleave at 9");
  });
});
