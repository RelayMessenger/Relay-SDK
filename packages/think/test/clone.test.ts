import type { Message } from "@relaymessenger/sdk";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({ action: (config: unknown) => ({ config }) }));

import { RelayGenerationActivities } from "../src/activity.js";
import {
  AGENT_HEADING,
  PERSON_HEADING,
  chatTimes,
  clefState,
  createGroupCompactFunction,
  groupTimeHeader,
  isOneEmoji,
  isPersonMessage,
  mergeGroupHistory,
  namesAgent,
  parseSummary,
  personLine,
  prepareSpeakGate,
  relayReaction,
  relaySessionId,
  renderSummary,
  searchSources,
  searchSourcesActions,
  validTimezone,
  validateTimezone,
  type SpeakDecision,
} from "../src/clone.js";

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const MSG_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("@relaymessenger/think/clone speak-gate", () => {
  const handles = [
    { id: "u1", handle: "alex", display_name: "Alex", kind: "user" as const, status: "active" as const },
    { id: "a1", handle: "jobs", display_name: "Steve Jobs", kind: "agent" as const, status: "active" as const },
    { id: "a2", handle: "graham", display_name: "Paul Graham", kind: "agent" as const, status: "active" as const },
  ];

  function makeRelay(recent: Message[]) {
    return {
      chats: {
        retrieve: vi.fn(async () => ({ id: CHAT_ID, is_group: true, handles })),
        messages: {
          list: vi.fn(async () => ({ data: [...recent].reverse() })),
        },
      },
      messages: {
        retrieve: vi.fn(),
        addReaction: vi.fn(async () => undefined),
      },
    } as never;
  }

  function makeEnvelope(parts: unknown[], senderKind = "user", senderHandle = "alex") {
    return {
      event_type: "message.received",
      data: {
        id: MSG_ID,
        direction: "inbound",
        chat: { id: CHAT_ID, is_group: true, owner_handle: { handle: "jobs", display_name: "Steve Jobs" } },
        sender_handle: { kind: senderKind, handle: senderHandle, is_me: false },
        parts,
      },
    };
  }

  it("recognizes multi-mention part.mentions even when Clef scores the agent low", async () => {
    let saved: SpeakDecision | undefined;
    const ai = {
      run: vi.fn(async () => ({
        answers: {
          a0: { type: "noul", noul: 0.1 }, // jobs scored low
          r0: { type: "noul", noul: 0.1 },
          a1: { type: "noul", noul: 0.9 }, // graham scored high
          r1: { type: "noul", noul: 0.1 },
        },
      })),
    };
    const recent: Message[] = [{
      id: MSG_ID,
      chat_id: CHAT_ID,
      is_from_me: false,
      is_system_message: false,
      delivery_status: "delivered",
      created_at: "2026-10-08T12:00:00Z",
      updated_at: "2026-10-08T12:00:00Z",
      from_handle: handles[0] as never,
      parts: [{ type: "text", value: "@graham @jobs both weigh in", reactions: null }],
    }];

    const result = await prepareSpeakGate(
      { AI: ai as never, RELAY_SPEAK_GATE: "clef", RELAY_SPEAK_PEERS: "graham", RELAY_SPEAK_STAGGER_S: "10" },
      makeEnvelope([{
        type: "text",
        value: "@graham @jobs both weigh in",
        mentions: [{ handle: "graham", is_me: false }, { handle: "jobs", is_me: true }],
      }]),
      {
        relay: makeRelay(recent),
        get: () => saved,
        put: (decision) => { saved = decision; },
      },
    );

    // jobs was mentioned via part.mentions (and ranked 2nd behind graham), so it speaks with stagger
    expect(result).toEqual({ kind: "deferred", delay: 10 });
    expect(saved?.spoke).toBe(true);
  });

  it("recognizes legacy part.mention as well", async () => {
    let saved: SpeakDecision | undefined;
    const ai = {
      run: vi.fn(async () => ({
        answers: {
          a0: { type: "noul", noul: 0.9 },
          r0: { type: "noul", noul: 0.1 },
          a1: { type: "noul", noul: 0.1 },
          r1: { type: "noul", noul: 0.1 },
        },
      })),
    };
    const recent: Message[] = [{
      id: MSG_ID,
      chat_id: CHAT_ID,
      is_from_me: false,
      is_system_message: false,
      delivery_status: "delivered",
      created_at: "2026-10-08T12:00:00Z",
      updated_at: "2026-10-08T12:00:00Z",
      from_handle: handles[0] as never,
      parts: [{ type: "text", value: "@jobs thoughts?", reactions: null }],
    }];

    const result = await prepareSpeakGate(
      { AI: ai as never, RELAY_SPEAK_GATE: "clef", RELAY_SPEAK_PEERS: "graham" },
      makeEnvelope([{ type: "text", value: "@jobs thoughts?", mention: "jobs" }]),
      {
        relay: makeRelay(recent),
        get: () => saved,
        put: (decision) => { saved = decision; },
      },
    );
    expect(result).toEqual({ kind: "turn" });
    expect(saved?.spoke).toBe(true);
  });

  it("evaluates helper predicates cleanly", () => {
    expect(namesAgent([{ type: "text", value: "Hey Steve, what do you think?" }], { handle: "jobs", display_name: "Steve Jobs" })).toBe(true);
    expect(namesAgent([{ type: "text", value: "Stevenson agreed" }], { handle: "jobs", display_name: "Steve Jobs" })).toBe(false);
    expect(isOneEmoji("🔥")).toBe(true);
    expect(isOneEmoji("🔥🔥")).toBe(false);
    expect(isOneEmoji("NONE")).toBe(false);
    expect(relayReaction("👍")).toEqual({ type: "like" });
    expect(relayReaction("🔥")).toEqual({ type: "custom", custom_emoji: "🔥" });
    expect(clefState(["Alex", "Steve"], ["Alex: hi", "Alex: thoughts?"])).toContain("Latest message:\nAlex: thoughts?");
  });
});

describe("@relaymessenger/think/clone group-compaction", () => {
  function personMsg(id: string, text: string): UIMessage {
    return {
      id,
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        turnMetadata: {
          message: {
            sent_at: "2026-10-08T14:30:00.000Z",
            sender_handle: { kind: "user", display_name: "Alex", handle: "alex" },
          },
        },
      },
    };
  }

  function agentMsg(id: string, text: string): UIMessage {
    return {
      id,
      role: "assistant",
      parts: [{ type: "text", text }],
    };
  }

  it("keeps person words verbatim and summarizes only agent lines", async () => {
    const p1 = personMsg("m1", "Alex: Budget is strictly $500.\nNo exceptions.");
    expect(isPersonMessage(p1)).toBe(true);
    expect(personLine(p1)).toBe("Alex [2026-10-08 14:30 UTC]: Budget is strictly $500.\n  No exceptions.");

    const rendered = renderSummary(["Alex: keep it simple"], "Paul suggested starting small.");
    expect(rendered).toContain(PERSON_HEADING);
    expect(rendered).toContain(AGENT_HEADING);
    expect(parseSummary(rendered)).toEqual({
      personBlock: ["Alex: keep it simple"],
      agentSummary: "Paul suggested starting small.",
    });

    const summarize = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain("Budget is strictly $500");
      expect(prompt).toContain("You (@jobs): Ship fast.");
      return "Steve suggested shipping fast.";
    });
    const compact = createGroupCompactFunction({
      summarize,
      keepRecentTokens: 10,
      selfName: "You (@jobs)",
      minCompactedTokens: 1,
    });
    const history: UIMessage[] = [
      personMsg("m0", "Opening"),
      agentMsg("m0b", "Hi"),
      personMsg("m0c", "Context"),
      personMsg("m1", "Budget is strictly $500."),
      agentMsg("m2", "Ship fast."),
      personMsg("m3", "Another recent turn to keep m2 in the compacted middle range."),
      personMsg("m4", "Latest message kept recent with enough words to fill recent budget."),
    ];
    const result = await compact(history as never);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Budget is strictly $500.");
    expect(result!.summary).toContain("Steve suggested shipping fast.");
    expect(summarize).toHaveBeenCalledOnce();
  });
});

describe("@relaymessenger/think/clone person-time and group-history", () => {
  it("formats time headers on first message and hour+ gaps, and validates timezones", () => {
    expect(validateTimezone("America/New_York")).toBe("America/New_York");
    expect(validTimezone("America/New_York")).toBe("America/New_York");
    expect(validTimezone("Not/A_Zone")).toBeUndefined();

    const t0 = new Date("2026-11-05T15:00:00.000Z");
    const t1 = new Date("2026-11-05T15:30:00.000Z"); // 30m later -> no header
    const t2 = new Date("2026-11-05T17:00:00.000Z"); // 90m later -> same-day time header
    const t3 = new Date("2026-11-06T18:00:00.000Z"); // next day -> dated header
    const headers = chatTimes([t0, t1, t2, t3], "America/New_York");
    expect(headers[0]).toMatch(/Nov 5/u);
    expect(headers[1]).toBeUndefined();
    expect(headers[2]).toBeDefined();
    expect(headers[2]).not.toMatch(/Nov 5/u);
    expect(headers[3]).toMatch(/Nov 6/u);
    expect(groupTimeHeader(t0.getTime(), t1.getTime(), "America/New_York")).toBeUndefined();
    expect(groupTimeHeader(t0.getTime(), t2.getTime(), "America/New_York")).toBeDefined();
  });

  it("merges missing group messages in chronological order without reordering stored rows", () => {
    expect(relaySessionId("abc")).toBe("relay:abc");
    const msg = (id: string, at: string): Message => ({
      id, chat_id: CHAT_ID, is_from_me: false, is_system_message: false,
      delivery_status: "delivered", created_at: at, updated_at: at, sent_at: at, parts: [],
    });
    const m1 = msg("1", "2026-10-08T12:00:00Z");
    const m2 = msg("2", "2026-10-08T12:05:00Z");
    const m3 = msg("3", "2026-10-08T12:10:00Z");
    const stored: UIMessage[] = [
      { id: relaySessionId("1"), role: "user", parts: [{ type: "text", text: "one" }] },
      { id: relaySessionId("3"), role: "user", parts: [{ type: "text", text: "three" }] },
    ];
    const missingRow: UIMessage = { id: relaySessionId("2"), role: "user", parts: [{ type: "text", text: "two" }] };
    const merged = mergeGroupHistory(
      stored,
      [{ message: m2, row: missingRow }],
      new Map([["1", m1], ["2", m2], ["3", m3]]),
    );
    expect(merged.map((m) => m.id)).toEqual(["relay:1", "relay:2", "relay:3"]);
  });
});

describe("@relaymessenger/think/clone search-sources", () => {
  it("embeds query, queries vector index, and exposes search_sources action only when CLONE_INDEX is bound", async () => {
    const vector = Array.from({ length: 1_024 }, () => 0.1);
    const env = {
      RELAY_AGENT_TOKEN: "tok",
      RELAY_API_ORIGIN: "https://api.example.test",
      AI: { run: vi.fn(async () => ({ data: [vector] })) } as never,
      CLONE_INDEX: {
        query: vi.fn(async () => ({
          matches: [{
            metadata: {
              text: "Focus means saying no.",
              title: "Keynote",
              date: "1997-05-01",
              url: "https://example.test/keynote",
              kind: "monologue",
              attribution: "own-writing",
              speaker_label: "Steve",
            },
          }],
        })),
      },
    };
    const passages = await searchSources(env, "focus");
    expect(passages).toEqual([{
      text: "Focus means saying no.",
      title: "Keynote",
      date: "1997-05-01",
      url: "https://example.test/keynote",
      kind: "monologue",
      attribution: "own-writing",
      speaker: "Steve",
    }]);

    const withoutIndex = searchSourcesActions({
      env: { RELAY_AGENT_TOKEN: "tok" },
      activities: new RelayGenerationActivities(),
      turn: () => ({ chatId: CHAT_ID, eventId: MSG_ID }),
      signal: (s) => s,
      assertCurrentTurn: () => undefined,
      waitUntil: () => undefined,
    });
    expect(Object.keys(withoutIndex)).toEqual([]);

    const withIndex = searchSourcesActions({
      env,
      activities: new RelayGenerationActivities(),
      turn: () => ({ chatId: CHAT_ID, eventId: MSG_ID }),
      signal: (s) => s,
      assertCurrentTurn: () => undefined,
      waitUntil: () => undefined,
    });
    expect(Object.keys(withIndex)).toEqual(["search_sources"]);
  });
});
