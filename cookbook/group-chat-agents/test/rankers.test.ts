import { describe, expect, it, vi } from "vitest";

import { CLEF_TIMEOUT_MS, clefRanker, namedRanker, type SpeakRankInput } from "../src/rankers";

const input = (latest: string, extra: Partial<SpeakRankInput> = {}): SpeakRankInput => ({
  state: `Latest message:\n${latest}`,
  latest,
  agents: ["Ada Lovelace", "Alan Turing", "Grace Hopper"],
  addressed: [false, false, false],
  fromPerson: true,
  ...extra,
});

describe("namedRanker: no model call", () => {
  it("scores an agent the Message names by first name", async () => {
    expect(await namedRanker(input("Advait: alan, what do you think?"))).toEqual([0, 1, 0]);
  });

  it("scores a mentioned or replied-to agent", async () => {
    expect(await namedRanker(input("Advait: thoughts?", { addressed: [false, false, true] }))).toEqual([0, 0, 1]);
  });

  it("ignores the sender's own name and names inside other words", async () => {
    expect(await namedRanker(input("Grace Hopper: gracefully done"))).toEqual([0, 0, 0]);
  });
});

describe("clefRanker", () => {
  it("asks Clef one question per agent and returns its scores", async () => {
    const run = vi.fn(async () => ({ answers: { a0: { type: "noul", noul: 0.2 }, a1: { type: "noul", noul: 0.8 }, a2: { type: "noul", noul: 0.5 } } }));
    expect(await clefRanker({ run })(input("Advait: who broke Enigma?"))).toEqual([0.2, 0.8, 0.5]);
    const [model, body] = run.mock.calls[0]! as unknown as [string, { model: string; questions: Record<string, { instructions: string }> }];
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(body.model).toBe("clef-flash");
    expect(body.questions.a1!.instructions).toBe("How much does the latest message touch Alan Turing's own life, work or expertise?");
  });

  it("asks a different question about another agent's Message", async () => {
    const run = vi.fn(async () => ({ answers: { a0: { noul: 0 }, a1: { noul: 0 }, a2: { noul: 0 } } }));
    await clefRanker({ run })(input("Alan Turing: yes", { fromPerson: false }));
    const body = (run.mock.calls[0] as unknown as [string, { questions: Record<string, { instructions: string }> }])[1];
    expect(body.questions.a0!.instructions).toContain("which the others have not already said");
  });

  it("throws on a missing score, so the gate fails open", async () => {
    await expect(clefRanker({ run: async () => ({ answers: { a0: { noul: 0.5 } } }) })(input("Advait: hi"))).rejects.toThrow("a1");
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = clefRanker({ run: () => new Promise(() => {}) })(input("Advait: hi"));
      const check = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(CLEF_TIMEOUT_MS);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
});
