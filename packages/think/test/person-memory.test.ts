import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  personMemoryContent,
  personMemoryLines,
  personMemoryName,
  personMemoryReader,
  personMemoryRow,
  personMemoryWrites,
  type PersonMemoryChat,
} from "../src/person-memory.js";

const ADVAIT = { id: "user-advait", kind: "user" as const, display_name: "Advait" };
const BOB = { id: "user-bob", kind: "user" as const, display_name: "Bob" };
const STEVE = { id: "agent-steve", kind: "agent" as const, display_name: "Steve Jobs", is_me: true };
const PAUL = { id: "agent-paul", kind: "agent" as const, display_name: "Paul Graham" };

function said(
  id: string,
  from: { id: string; kind: "user" | "agent"; display_name: string },
  text: string,
): UIMessage {
  return {
    id: `ui-${id}`,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: {
      turnMetadata: {
        message: {
          id,
          sent_at: "2026-10-08T12:00:00.000Z",
          sender_handle: { id: from.id, display_name: from.display_name, kind: from.kind },
        },
      },
    },
  };
}

function replied(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{
      type: "tool-send",
      toolCallId: `call-${id}`,
      state: "output-available",
      input: { kind: "text", text },
      output: { status: "sent" },
    }],
  } as UIMessage;
}

describe("per-person memory routing", () => {
  const council: PersonMemoryChat = {
    id: "chat-council",
    display_name: "The Council",
    is_group: true,
    handles: [ADVAIT, STEVE, PAUL],
  };
  const councilHistory = [
    said("m1", ADVAIT, "Should Relay raise now?"),
    said("m2", PAUL, "Default alive first."),
    replied("m3", "Ship the product people love."),
  ];

  it("gives the one person in a Chat every line, other agents included", () => {
    const lines = personMemoryLines(council, councilHistory);
    const writes = personMemoryWrites(council, lines);
    expect([...writes.keys()]).toEqual([ADVAIT.id]);
    expect(writes.get(ADVAIT.id)!.map((line) => `${line.speaker}: ${line.text}`)).toEqual([
      "Advait: Should Relay raise now?",
      "Paul Graham: Default alive first.",
      "Steve Jobs: Ship the product people love.",
    ]);
    expect(personMemoryReader(council, lines)).toBe(ADVAIT.id);
  });

  it("gives each of two people only their own lines and this agent's answers to them", () => {
    const pair: PersonMemoryChat = {
      id: "chat-pair",
      display_name: "Launch",
      is_group: true,
      handles: [ADVAIT, BOB, STEVE, PAUL],
    };
    const lines = personMemoryLines(pair, [
      said("p1", ADVAIT, "Advait asks about pricing."),
      replied("p2", "Answer to Advait."),
      said("p3", BOB, "Bob's private salary is 90k."),
      replied("p4", "Answer to Bob."),
      said("p5", PAUL, "Paul weighs in."),
    ]);
    const writes = personMemoryWrites(pair, lines);
    expect(writes.get(ADVAIT.id)!.map((line) => line.text)).toEqual([
      "Advait asks about pricing.",
      "Answer to Advait.",
    ]);
    expect(writes.get(BOB.id)!.map((line) => line.text)).toEqual([
      "Bob's private salary is 90k.",
      "Answer to Bob.",
    ]);
    expect(personMemoryReader(pair, lines)).toBeUndefined();
  });

  it("counts a person who left by their lines, so a Chat they spoke in stays shared", () => {
    const chat: PersonMemoryChat = {
      id: "chat-left",
      is_group: true,
      handles: [ADVAIT, { ...BOB, status: "left" }, STEVE],
    };
    const lines = personMemoryLines(chat, [said("l1", BOB, "Bob before leaving.")]);
    expect(personMemoryReader(chat, lines)).toBeUndefined();
    expect(personMemoryWrites(chat, lines).get(ADVAIT.id)).toBeUndefined();
  });

  it("stores only what this agent's sends delivered", () => {
    const refused = replied("r1", "This send was refused.");
    (refused.parts[0] as { output: unknown }).output = { status: "terminal_ambiguous" };
    const lines = personMemoryLines(council, [said("r0", ADVAIT, "hi"), refused, replied("r2", "Delivered.")]);
    expect(lines.map((line) => line.text)).toEqual(["hi", "Delivered."]);
  });

  it("keys rows by Chat and Message and labels them with the Chat and date", () => {
    const [line] = personMemoryLines(council, councilHistory);
    expect(line!.key).toBe("chat-council:m1");
    expect(personMemoryRow("The Council", line!)).toBe(
      "[The Council, 2026-10-08] Advait: Should Relay raise now?",
    );
    expect(personMemoryName("u1")).toBe("person:u1");
    expect(personMemoryName("u1", "a1")).toBe("person:a1:u1");
  });

  it("renders nothing when there is nothing to show", () => {
    expect(personMemoryContent({ chats: [], hits: [] })).toBeUndefined();
    expect(personMemoryContent({ chats: [{ label: "DM", lines: ["[DM, 2026-10-08] Advait: hi"] }], hits: [] }))
      .toContain("## DM\n[DM, 2026-10-08] Advait: hi");
  });
});
