// The owner's case (2026-10-08): Steve Jobs, in a DM with Advait, did not know
// what was said in Advait's group "The Council" with Steve Jobs, Paul Graham
// and Elon Musk. Here the DM turn's prompt must carry Advait's, Paul's and
// Elon's lines from The Council, and never a line another person said in a
// Chat with two people.
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { personMemoryName, type PersonMemoryChat, type RelayPersonMemory } from "../../src/memory.js";
import type { Env, MemoryTestAgentRpc } from "./worker.js";

const testEnv = env as unknown as Env;

const ADVAIT = { id: "user-advait", kind: "user" as const, display_name: "Advait" };
const BOB = { id: "user-bob", kind: "user" as const, display_name: "Bob" };
const STEVE = { id: "agent-steve", kind: "agent" as const, display_name: "Steve Jobs", is_me: true };
const PAUL = { id: "agent-paul", kind: "agent" as const, display_name: "Paul Graham" };
const ELON = { id: "agent-elon", kind: "agent" as const, display_name: "Elon Musk" };

const COUNCIL: PersonMemoryChat = {
  id: "chat-council",
  display_name: "The Council",
  is_group: true,
  handles: [ADVAIT, STEVE, PAUL, ELON],
};
const LAUNCH: PersonMemoryChat = {
  id: "chat-launch",
  display_name: "Launch",
  is_group: true,
  handles: [ADVAIT, BOB, STEVE],
};
const DM: PersonMemoryChat = { id: "chat-dm", is_group: false, handles: [ADVAIT, STEVE] };
const BOB_DM: PersonMemoryChat = { id: "chat-bob-dm", is_group: false, handles: [BOB, STEVE] };

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
          sent_at: "2026-10-08T18:00:00.000Z",
          sender_handle: { id: from.id, display_name: from.display_name, kind: from.kind },
        },
      },
    },
  };
}

function replied(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

const agent = async (chat: PersonMemoryChat) =>
  (await getAgentByName(testEnv.MemoryTestAgent as never, chat.id)) as unknown as MemoryTestAgentRpc;

describe("per-person memory in a Think agent", () => {
  it("brings The Council into the DM, and keeps another person's lines out", async () => {
    await (await agent(COUNCIL)).seed(COUNCIL, [
      said("c1", ADVAIT, "Council: should Relay charge builders per agent?"),
      said("c2", PAUL, "Paul: charge once they get paid, not before."),
      said("c3", ELON, "Elon: make it free and win on volume."),
      replied("c4", "Steve: one price, simple, no tiers."),
    ]);
    await (await agent(LAUNCH)).seed(LAUNCH, [
      said("l1", ADVAIT, "Launch: the date is Tuesday."),
      said("l2", BOB, "Bob secret: my salary is ninety thousand."),
      replied("l3", "Steve answers Bob about salary."),
    ]);

    // In a Chat with two people, nothing is read.
    const launchPrompt = await (await agent(LAUNCH)).turn(
      LAUNCH,
      said("l4", ADVAIT, "What did the Council say?"),
    );
    expect(launchPrompt).not.toContain("person_memory");
    expect(launchPrompt).not.toContain("search_person_memory");

    const prompt = await (await agent(DM)).turn(DM, said("d1", ADVAIT, "Remind me what we decided on pricing."));
    expect(prompt).toContain("search_person_memory");
    expect(prompt).toContain("## The Council");
    expect(prompt).toContain("Advait: Council: should Relay charge builders per agent?");
    expect(prompt).toContain("Paul Graham: Paul: charge once they get paid, not before.");
    expect(prompt).toContain("Elon Musk: Elon: make it free and win on volume.");
    expect(prompt).toContain("Steve Jobs: Steve: one price, simple, no tiers.");
    // Advait's own line from Launch, never Bob's line or the answer to Bob.
    expect(prompt).toContain("Advait: Launch: the date is Tuesday.");
    expect(prompt).not.toContain("Bob secret");
    expect(prompt).not.toContain("Steve answers Bob");

    // Bob's memory holds his own line, and none of Advait's.
    const bob = (await getAgentByName(testEnv.RelayPersonMemory as never, personMemoryName(BOB.id))) as unknown as
      Pick<RelayPersonMemory, "recall">;
    const bobRecall = await bob.recall(BOB_DM.id, "");
    const bobLines = bobRecall.chats.flatMap((chat) => chat.lines).join("\n");
    expect(bobLines).toContain("Bob: Bob secret");
    expect(bobLines).not.toContain("Advait");

    // The DM turn itself was stored, and a later turn in the Council reads it.
    const councilPrompt = await (await agent(COUNCIL)).turn(COUNCIL, said("c5", ADVAIT, "pricing again"));
    expect(councilPrompt).toContain("## DM");
    expect(councilPrompt).toContain("Advait: Remind me what we decided on pricing.");
    expect(councilPrompt).not.toContain("Bob secret");
  });
});
