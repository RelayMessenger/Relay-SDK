import { describe, expect, it, vi } from "vitest";

import { AGENT_STAGGER_SECONDS, PERSON_STEP_SECONDS, speakGate, speakState } from "../src/speak-gate";
import { chat, deps, event } from "./fixtures";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

// Scores are in the order [Ada (this agent), Alan, Grace]. @relay is in the
// group but runs no gate, so it is not in the order.

describe("a person's Message: every agent takes a turn, in order", () => {
  it("the top-scored agent goes now, with the group history", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "What is a program?" }]);
    const { dependencies, store, ranked } = deps(messages, [0.9, 0.2, 0.5]);
    const result = await speakGate(event(latest, sender), dependencies);
    expect(result).toEqual({ kind: "turn", history: "Advait: What is a program?" });
    expect(store.decision).toEqual({ spoke: true, readyAt: 1_000_000 });
    expect(ranked[0]!.agents).toEqual(["Ada Lovelace", "Alan Turing", "Grace Hopper"]);
    expect(ranked[0]!.fromPerson).toBe(true);
  });

  it("a lower-scored agent still takes its turn, one step per agent ahead", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "Who broke Enigma?" }]);
    const { dependencies, store } = deps(messages, [0.1, 0.9, 0.5]);
    expect(await speakGate(event(latest, sender), dependencies)).toEqual({ kind: "deferred", seconds: 2 * PERSON_STEP_SECONDS });
    expect(store.decision!.spoke).toBe(true);
  });

  it("an agent the person mentions goes first, whatever the scores", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "@grace what was the first bug?" }]);
    const { dependencies } = deps(messages, [0.9, 0.1, 0.1]);
    expect(await speakGate(event(latest, sender, { mention: "grace" }), dependencies))
      .toEqual({ kind: "deferred", seconds: PERSON_STEP_SECONDS });
  });

  it("an addressed agent counts as one step, not twice", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "@grace and everyone: COBOL?" }]);
    const { dependencies } = deps(messages, [0.5, 0.1, 0.9]);
    expect(await speakGate(event(latest, sender, { mention: "grace" }), dependencies))
      .toEqual({ kind: "deferred", seconds: PERSON_STEP_SECONDS });
  });

  it("an agent the person mentions answers now without a ranking", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "@ada hi" }]);
    const { dependencies, ranked } = deps(messages, [0, 0, 0]);
    expect(await speakGate(event(latest, sender, { mention: "ada" }), dependencies))
      .toEqual({ kind: "turn", history: "Advait: @ada hi" });
    expect(ranked).toHaveLength(0);
  });

  it("a person's reply to this agent's Message answers now", async () => {
    const { messages, latest, sender } = chat([
      { from: "ada", text: "Engines can weave patterns.", mine: true },
      { from: "advait", text: "Tell me more" },
    ]);
    const { dependencies, ranked } = deps(messages, [0, 0, 0]);
    const result = await speakGate(event(latest, sender, { replyTo: messages[0]!.id }), dependencies);
    expect(result.kind).toBe("turn");
    expect(ranked).toHaveLength(0);
  });

  it("a person's reply to another agent puts that agent first", async () => {
    const { messages, latest, sender } = chat([
      { from: "alan", text: "Machines can think." },
      { from: "advait", text: "Can they?" },
    ]);
    const { dependencies } = deps(messages, [0.9, 0.1, 0.2]);
    expect(await speakGate(event(latest, sender, { replyTo: messages[0]!.id }), dependencies))
      .toEqual({ kind: "deferred", seconds: PERSON_STEP_SECONDS });
  });
});

describe("another agent's Message: answer only past the threshold", () => {
  it("a high score answers, sooner the surer it is", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "Thoughts?" }, { from: "alan", text: "Ada, was the Engine a computer?" }]);
    const { dependencies, store } = deps(messages, [0.75, 0, 0.1]);
    expect(await speakGate(event(latest, sender), dependencies))
      .toEqual({ kind: "deferred", seconds: Math.round(0.25 * AGENT_STAGGER_SECONDS) });
    expect(store.decision!.spoke).toBe(true);
  });

  it("a low score stays out, and the decision is kept", async () => {
    const { messages, latest, sender } = chat([{ from: "alan", text: "Machines can think." }]);
    const { dependencies, store } = deps(messages, [0.3, 0, 0.9]);
    expect(await speakGate(event(latest, sender), dependencies)).toEqual({ kind: "silent" });
    expect(store.decision).toEqual({ spoke: false, readyAt: 1_000_000 });
  });

  it("an agent that sent 2 of the last 4 Messages needs a higher score", async () => {
    const { messages, latest, sender } = chat([
      { from: "ada", text: "One.", mine: true },
      { from: "alan", text: "Two." },
      { from: "ada", text: "Three.", mine: true },
      { from: "alan", text: "Four?" },
    ]);
    const { dependencies } = deps(messages, [0.6, 0, 0]);
    expect(await speakGate(event(latest, sender), dependencies)).toEqual({ kind: "silent" });
  });

  it("a mention from another agent still goes through the gate", async () => {
    const { messages, latest, sender } = chat([{ from: "alan", text: "@ada agreed?" }]);
    const { dependencies, ranked } = deps(messages, [0.2, 0, 0]);
    expect(await speakGate(event(latest, sender, { mention: "ada" }), dependencies)).toEqual({ kind: "silent" });
    expect(ranked).toHaveLength(1);
  });
});

describe("the decision survives the wait", () => {
  it("a saved silence stays silent", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "hi" }]);
    const { dependencies, ranked } = deps(messages, [1, 1, 1], { spoke: false, readyAt: 0 });
    expect(await speakGate(event(latest, sender), dependencies)).toEqual({ kind: "silent" });
    expect(ranked).toHaveLength(0);
  });

  it("a wait not yet over waits again", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "hi" }]);
    const { dependencies } = deps(messages, [1, 1, 1], { spoke: true, readyAt: 1_004_500 });
    expect(await speakGate(event(latest, sender), dependencies)).toEqual({ kind: "deferred", seconds: 5 });
  });

  it("after the wait the turn reads the history afresh, replies of the agents ahead included", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "hi" }]);
    const later = chat([{ from: "advait", text: "hi" }, { from: "alan", text: "Hello!" }]).messages;
    const { dependencies, ranked } = deps(later, [1, 1, 1], { spoke: true, readyAt: 1_000_000 });
    expect(await speakGate(event(latest, sender), dependencies))
      .toEqual({ kind: "turn", history: "Advait: hi\nAlan Turing: Hello!" });
    expect(ranked).toHaveLength(0);
  });
});

describe("edges", () => {
  it("a direct Message is not gated", async () => {
    const { messages, latest, sender } = chat([{ from: "advait", text: "hi" }]);
    const { dependencies, ranked } = deps(messages, [0, 0, 0]);
    expect(await speakGate(event(latest, sender, { isGroup: false }), dependencies)).toEqual({ kind: "turn" });
    expect(ranked).toHaveLength(0);
  });

  it("a ranker failure takes the turn, once", async () => {
    const { messages, latest, sender } = chat([{ from: "alan", text: "hm" }]);
    const { dependencies, store } = deps(messages, new Error("down"));
    expect(await speakGate(event(latest, sender), dependencies)).toEqual({ kind: "turn", history: "Alan Turing: hm" });
    expect(store.decision).toEqual({ spoke: true, readyAt: 1_000_000 });
  });

  it("every agent scores the chat only up to the triggering Message", async () => {
    const first = chat([{ from: "advait", text: "first" }]);
    const both = chat([{ from: "advait", text: "first" }, { from: "advait", text: "second" }]).messages;
    const { dependencies, ranked } = deps(both, [1, 0, 0]);
    await speakGate(event(first.latest, first.sender), dependencies);
    expect(ranked[0]!.latest).toBe("Advait: first");
    expect(ranked[0]!.state).not.toContain("second");
  });

  it("the state sets the latest Message apart from the earlier ones", () => {
    expect(speakState(["A", "B"], ["A: one", "B: two"])).toBe(
      "Group chat members: A, B.\n\nEarlier messages, context only:\nA: one\n\nLatest message:\nB: two",
    );
  });
});
