// The owner's case (2026-10-08): Steve Jobs, in a DM with Advait, did not know
// what was said in Advait's group "The Council" with Steve Jobs, Paul Graham
// and Elon Musk. Here the DM turn's prompt must carry Advait's, Paul's and
// Elon's lines from The Council. Since 2026-11-05 (owner: the agent has the
// group's context when he texts it), a group with two people is stored for
// every member, and with a Relay client the DM reads the group from Relay.
import type { Message } from "@relaymessenger/sdk";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { personMemoryName, type PersonMemoryChat, type RelayPersonMemory } from "../../src/memory.js";
import type { Env, FakeRelayData, MemoryTestAgentRpc } from "./worker.js";

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
    // Launch, as Advait saw it there: his line, Bob's, and the answer to Bob
    // (reversed 2026-11-05 by owner direction; it used to keep Bob's out).
    expect(prompt).toContain("Advait: Launch: the date is Tuesday.");
    expect(prompt).toContain("Bob: Bob secret: my salary is ninety thousand.");
    expect(prompt).toContain("Steve Jobs: Steve answers Bob about salary.");

    // Bob's memory holds the whole of Launch too.
    const bob = (await getAgentByName(testEnv.RelayPersonMemory as never, personMemoryName(BOB.id))) as unknown as
      Pick<RelayPersonMemory, "recall">;
    const bobRecall = await bob.recall(BOB_DM.id, "");
    const bobLines = bobRecall.chats.flatMap((chat) => chat.lines).join("\n");
    expect(bobLines).toContain("Bob: Bob secret");
    expect(bobLines).toContain("Advait: Launch: the date is Tuesday.");

    // The DM turn itself was stored, and a later turn in the Council reads it.
    const councilPrompt = await (await agent(COUNCIL)).turn(COUNCIL, said("c5", ADVAIT, "pricing again"));
    expect(councilPrompt).toContain("## DM");
    expect(councilPrompt).toContain("Advait: Remind me what we decided on pricing.");
  });
});

const CARA = { id: "user-cara", kind: "user" as const, display_name: "Cara" };
const DAN = { id: "user-dan", kind: "user" as const, display_name: "Dan" };
const ERIN = { id: "user-erin", kind: "user" as const, display_name: "Erin" };
const FAY = { id: "user-fay", kind: "user" as const, display_name: "Fay" };

function handle(
  from: { id: string; kind: "user" | "agent"; display_name: string; is_me?: boolean },
  extra: { joined_at?: string; status?: "active" | "left" | "removed"; left_at?: string } = {},
) {
  return { ...from, handle: from.display_name.toLowerCase(), joined_at: "2026-09-01T00:00:00.000Z", ...extra };
}

function onRelay(
  chatId: string,
  id: string,
  from: { id: string; kind: "user" | "agent"; display_name: string; is_me?: boolean },
  sentAt: string,
  parts: Message["parts"],
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    chat_id: chatId,
    from_handle: handle(from) as Message["from_handle"],
    parts,
    is_system_message: false,
    is_from_me: from.is_me === true,
    delivery_status: "delivered",
    created_at: sentAt,
    updated_at: sentAt,
    sent_at: sentAt,
    ...extra,
  };
}

const text = (value: string) => [{ type: "text" as const, value, reactions: null }];

describe("a DM reads the shared groups from Relay", () => {
  // Cara joined Trip on 2026-10-01; Dan had talked there before. The agent
  // took in only the line that mentioned it; the rest exists only on Relay.
  const TRIP: PersonMemoryChat = {
    id: "chat-trip",
    display_name: "Trip",
    is_group: true,
    handles: [handle(CARA, { joined_at: "2026-10-01T00:00:00.000Z" }), handle(DAN), handle(STEVE)],
  };
  const CREW: PersonMemoryChat = {
    id: "chat-crew",
    display_name: "Old Crew",
    is_group: true,
    handles: [handle(CARA), handle(DAN), handle(STEVE)],
  };
  const CARA_DM: PersonMemoryChat = { id: "chat-cara-dm", is_group: false, handles: [handle(CARA), handle(STEVE)] };

  it("shows the whole group since the person joined, and no group they left", async () => {
    await (await agent(TRIP)).seed(TRIP, [said("t-cara", CARA, "Steve, plan the trip for us.")]);
    await (await agent(CREW)).seed(CREW, [said("o-cara", CARA, "Old Crew line from Cara.")]);

    const relay: FakeRelayData = {
      chats: {
        [TRIP.id]: TRIP,
        [CREW.id]: { ...CREW, handles: [handle(CARA, { status: "left", left_at: "2026-10-20T00:00:00.000Z" }), handle(DAN), handle(STEVE)] },
      },
      messages: {
        [TRIP.id]: [
          onRelay(TRIP.id, "t-before", DAN, "2026-09-20T10:00:00.000Z", text("Dan before Cara joined: old plan.")),
          onRelay(TRIP.id, "t-cara", CARA, "2026-10-02T10:00:00.000Z", text("Steve, plan the trip for us.")),
          onRelay(TRIP.id, "t-dan", DAN, "2026-10-02T10:05:00.000Z", text("Dan only on Relay: book the cabin.")),
          onRelay(TRIP.id, "t-photo", DAN, "2026-10-02T10:06:00.000Z", [{
            type: "media", id: "p1", url: "https://example.invalid/p.jpg", filename: "cabin.jpg",
            mime_type: "image/jpeg", size_bytes: 1, reactions: null,
          }]),
          onRelay(TRIP.id, "t-steve", STEVE, "2026-10-02T10:07:00.000Z", text("Steve: Friday works.")),
          onRelay(TRIP.id, "t-system", DAN, "2026-10-02T10:08:00.000Z", [], { is_system_message: true }),
        ],
        [CREW.id]: [onRelay(CREW.id, "o-dan", DAN, "2026-10-21T10:00:00.000Z", text("Crew after Cara left."))],
      },
    };

    const dm = await agent(CARA_DM);
    const prompt = await dm.turn(CARA_DM, said("cd1", CARA, "What did we settle for the trip?"), relay);
    expect(prompt).toContain("## Trip");
    expect(prompt).toContain("[Trip, 2026-10-02] Cara: Steve, plan the trip for us.");
    expect(prompt).toContain("[Trip, 2026-10-02] Dan: Dan only on Relay: book the cabin.");
    expect(prompt).toContain("[Trip, 2026-10-02] Dan: [Image]");
    expect(prompt).toContain("[Trip, 2026-10-02] Steve Jobs: Steve: Friday works.");
    expect(prompt).not.toContain("Dan before Cara joined");
    expect(prompt).not.toContain("Old Crew");
    expect(prompt).not.toContain("Crew after Cara left");
    expect(await dm.relayCalls()).toContain(`list ${TRIP.id} desc 30 signal`);
    expect(await dm.relayCalls()).toContain(`retrieve ${TRIP.id} signal`);
  });

  it("drops and purges chats returning 403 or 404, and filters search_person_memory hits", async () => {
    const GINA = { id: "user-gina", kind: "user" as const, display_name: "Gina" };
    const HANK = { id: "user-hank", kind: "user" as const, display_name: "Hank" };
    const SECRET_403: PersonMemoryChat = {
      id: "chat-secret-403",
      display_name: "Secret 403",
      is_group: true,
      handles: [handle(GINA), handle(HANK), handle(STEVE)],
    };
    const DELETED_404: PersonMemoryChat = {
      id: "chat-deleted-404",
      display_name: "Deleted 404",
      is_group: true,
      handles: [handle(GINA), handle(HANK), handle(STEVE)],
    };
    const ACTIVE: PersonMemoryChat = {
      id: "chat-active-gina",
      display_name: "Active Group",
      is_group: true,
      handles: [handle(GINA), handle(HANK), handle(STEVE)],
    };
    const GINA_DM: PersonMemoryChat = { id: "chat-gina-dm", is_group: false, handles: [handle(GINA), handle(STEVE)] };

    await (await agent(SECRET_403)).seed(SECRET_403, [said("s1", HANK, "Classified orchid blueprint.")]);
    await (await agent(DELETED_404)).seed(DELETED_404, [said("d1", HANK, "Deleted orchid notes.")]);
    await (await agent(ACTIVE)).seed(ACTIVE, [said("a1", GINA, "Public orchid garden.")]);

    const dm = await agent(GINA_DM);
    const relay: FakeRelayData = {
      chats: { [ACTIVE.id]: ACTIVE },
      messages: {
        [ACTIVE.id]: [onRelay(ACTIVE.id, "a1", GINA, "2026-10-02T10:00:00.000Z", text("Public orchid garden."))],
      },
      errors: {
        [SECRET_403.id]: 403,
        [DELETED_404.id]: 404,
      },
    };

    const prompt = await dm.turn(GINA_DM, said("gd1", GINA, "What about orchid?"), relay);
    expect(prompt).toContain("Public orchid garden.");
    expect(prompt).not.toContain("Classified orchid blueprint.");
    expect(prompt).not.toContain("Deleted orchid notes.");

    // Both revoked chats were purged from stored person memory and FTS search index.
    const ginaMem = (await getAgentByName(testEnv.RelayPersonMemory as never, personMemoryName(GINA.id))) as unknown as
      Pick<RelayPersonMemory, "recall" | "search">;
    const afterRecall = await ginaMem.recall(GINA_DM.id, "orchid");
    expect(afterRecall.chats.map((c) => c.chatId)).toEqual([ACTIVE.id]);
    expect(await ginaMem.search("orchid", GINA_DM.id)).toEqual([
      "[Active Group, 2026-10-08] Gina: Public orchid garden.",
    ]);

    // search_person_memory also verifies hits from chats outside the top 5 and purges revoked ones.
    const OLD_REVOKED: PersonMemoryChat = {
      id: "chat-old-revoked",
      display_name: "Old Revoked",
      is_group: true,
      handles: [handle(GINA), handle(HANK), handle(STEVE)],
    };
    const oldMessage = said("old-1", HANK, "Vintage saffron recipe.");
    (oldMessage.metadata as { turnMetadata: { message: { sent_at: string } } }).turnMetadata.message.sent_at = "2025-01-01T00:00:00.000Z";
    await (await agent(OLD_REVOKED)).seed(OLD_REVOKED, [oldMessage]);
    // Seed 5 newer active chats so OLD_REVOKED is pushed outside PERSON_MEMORY_CHATS (5).
    const newerChats: Record<string, PersonMemoryChat> = { [ACTIVE.id]: ACTIVE };
    const newerMessages: Record<string, Message[]> = {
      [ACTIVE.id]: [onRelay(ACTIVE.id, "a1", GINA, "2026-10-02T10:00:00.000Z", text("Public orchid garden."))],
    };
    for (let i = 1; i <= 5; i += 1) {
      const chat: PersonMemoryChat = {
        id: `chat-newer-${i}`,
        display_name: `Newer ${i}`,
        is_group: true,
        handles: [handle(GINA), handle(STEVE)],
      };
      const msg = said(`n-${i}`, GINA, `Recent chat ${i}.`);
      (msg.metadata as { turnMetadata: { message: { sent_at: string } } }).turnMetadata.message.sent_at = `2026-11-0${i}T00:00:00.000Z`;
      await (await agent(chat)).seed(chat, [msg]);
      newerChats[chat.id] = chat;
      newerMessages[chat.id] = [onRelay(chat.id, `n-${i}`, GINA, `2026-11-0${i}T00:00:00.000Z`, text(`Recent chat ${i}.`))];
    }

    const searchResult = await dm.searchTool(GINA_DM, "saffron", {
      chats: newerChats,
      messages: newerMessages,
      errors: { [OLD_REVOKED.id]: 403 },
    });
    expect(searchResult.lines).toEqual([]);
    expect(await ginaMem.search("saffron", GINA_DM.id)).toEqual([]);
  });

  it("drops and forgets a chat on a cross-package RelayAPIError-shaped 403", async () => {
    const HANK = { id: "user-hank", handle: "hank", kind: "user" as const, display_name: "Hank" };
    const REVOKED: PersonMemoryChat = {
      id: "chat-foreign-403",
      display_name: "Secret Room",
      is_group: true,
      handles: [handle(HANK), handle(STEVE)],
    };
    const HANK_DM: PersonMemoryChat = { id: "chat-hank-dm", is_group: false, handles: [handle(HANK), handle(STEVE)] };
    await (await agent(REVOKED)).seed(REVOKED, [said("f1", HANK, "Top secret launch date.")]);
    const prompt = await (await agent(HANK_DM)).turn(
      HANK_DM,
      said("hd1", HANK, "What was the launch date?"),
      { chats: {}, messages: {}, foreignErrors: { [REVOKED.id]: 403 } },
    );
    expect(prompt).not.toContain("Secret Room");
    expect(prompt).not.toContain("Top secret launch date.");
  });

  it("falls back to the stored lines when Relay fails", async () => {
    const CLUB: PersonMemoryChat = {
      id: "chat-club",
      display_name: "Book Club",
      is_group: true,
      handles: [handle(ERIN), handle(FAY), handle(STEVE)],
    };
    const ERIN_DM: PersonMemoryChat = { id: "chat-erin-dm", is_group: false, handles: [handle(ERIN), handle(STEVE)] };
    await (await agent(CLUB)).seed(CLUB, [
      said("b1", ERIN, "Erin: next book is Dune."),
      said("b2", FAY, "Fay: I will bring snacks."),
    ]);
    const prompt = await (await agent(ERIN_DM)).turn(
      ERIN_DM,
      said("ed1", ERIN, "What is the next book?"),
      { chats: {}, messages: {}, throws: true },
    );
    expect(prompt).toContain("## Book Club");
    expect(prompt).toContain("Erin: Erin: next book is Dune.");
    expect(prompt).toContain("Fay: Fay: I will bring snacks.");
  });
});
