import { describe, expect, it } from "vitest";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { bridgeTurn } from "./bridge-turn.js";
import { inboundMediaPrompt } from "./inbound-media.js";
import { answerMessages, codexPrompt } from "./codex-bridge.js";

describe("CLI selection authoring and discovery", () => {
  it("teaches selections and lifts them through the shared Codex/Claude send path", () => {
    const prompt = codexPrompt("alice", "send selections");
    expect(prompt).toContain("fenced code block tagged `selection`");
    expect(prompt).toContain("If the person asks for selections");
    const warnings: string[] = [];
    expect(answerMessages('Topics?\n```selection\n[{"value":"research","label":"Research"}]\n```', "alice", text => warnings.push(text))).toEqual([
      [{ type: "text", value: "Topics?" }, { type: "selection", options: [{ value: "research", label: "Research" }] }],
    ]);
    expect(warnings).toEqual([]);
  });

  it("preserves readable text and sends explicit selection source/value data to the model", async () => {
    const event = {
      event_type: "message.received", event_id: "selection-event",
      data: {
        direction: "inbound", chat: { id: "chat" }, sender_handle: { handle: "alice" },
        parts: [
          { type: "text", value: "Research, Design", reactions: null },
          { type: "selection_response", selected_values: ["research", "design"] },
        ],
        reply_to: { message_id: "source", part_index: 1 },
      },
    } as RelayWebhookEvent;
    const turn = bridgeTurn(event)!;
    expect(turn.text).toBe("Research, Design");
    expect(turn.selection).toEqual({
      selected_values: ["research", "design"], reply_to: { message_id: "source", part_index: 1 },
    });
    const context = await inboundMediaPrompt(turn);
    expect(context.text).toContain('"selected_values":["research","design"]');
    expect(context.text).toContain('"reply_to":{"message_id":"source","part_index":1}');
    expect(context.text.startsWith("Research, Design")).toBe(true);
  });
});
