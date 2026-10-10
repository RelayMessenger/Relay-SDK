import type { Message } from "@relaymessenger/sdk";

import type { SpeakDecision, SpeakGateDependencies } from "../src/speak-gate";
import type { SpeakRankInput } from "../src/rankers";

export const CHAT = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const MEMBERS = [
  { handle: "advait", display_name: "Advait", kind: "user", status: "active" },
  { handle: "ada", display_name: "Ada Lovelace", kind: "agent", status: "active" },
  { handle: "alan", display_name: "Alan Turing", kind: "agent", status: "active" },
  { handle: "grace", display_name: "Grace Hopper", kind: "agent", status: "active" },
  { handle: "relay", display_name: "Relay", kind: "agent", status: "active" },
];

interface Line { from: string; text: string; mine?: boolean }

/** A group chat as this agent (Ada) sees it, newest last. */
export function chat(lines: Line[]) {
  const messages = lines.map((line, index) => ({
    id: id(index + 1),
    is_from_me: line.mine === true,
    from_handle: MEMBERS.find((member) => member.handle === line.from),
    parts: [{ type: "text", value: line.text }],
  })) as unknown as Message[];
  const latest = messages.at(-1)!;
  const sender = MEMBERS.find((member) => member.handle === lines.at(-1)!.from)!;
  return { messages, latest, sender };
}

export function event(
  latest: Message,
  sender: { kind: string },
  extra: { mention?: string; replyTo?: string; isGroup?: boolean } = {},
) {
  return {
    event_type: "message.received",
    data: {
      id: latest.id,
      chat: { id: CHAT, is_group: extra.isGroup ?? true, owner_handle: { handle: "ada", display_name: "Ada Lovelace" } },
      sender_handle: { kind: sender.kind, is_me: false },
      parts: [{ type: "text", mention: extra.mention ?? null }],
      reply_to: extra.replyTo ? { message_id: extra.replyTo } : null,
    },
  };
}

/** Speak-gate dependencies over a fake Relay, a fixed clock and fixed scores. */
export function deps(messages: Message[], scores: number[] | Error, saved?: SpeakDecision) {
  const store: { decision?: SpeakDecision } = saved ? { decision: saved } : {};
  const ranked: SpeakRankInput[] = [];
  const dependencies: SpeakGateDependencies = {
    now: () => 1_000_000,
    peers: new Set(["alan", "grace"]),
    relay: {
      chats: {
        retrieve: async () => ({ id: CHAT, handles: MEMBERS }),
        messages: { list: async () => ({ data: [...messages].reverse() }) },
      },
      messages: {
        retrieve: async (messageId: string) => messages.find((message) => message.id === messageId)!,
      },
    } as unknown as SpeakGateDependencies["relay"],
    rank: async (input) => {
      ranked.push(input);
      if (scores instanceof Error) throw scores;
      return scores;
    },
    get: () => store.decision,
    put: (decision) => { store.decision = decision; },
  };
  return { dependencies, store, ranked };
}
