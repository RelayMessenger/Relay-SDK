import { expect, it } from "vitest";

import { configurationErrors } from "../src/env";
import { namedRanker } from "../src/rankers";
import { speakPeers, speakRanker } from "../src/env";

it("reads the peers list", () => {
  expect([...speakPeers(" alan, grace ,,")]).toEqual(["alan", "grace"]);
});

it("uses the named ranker unless Clef is asked for", () => {
  expect(speakRanker({ SPEAK_RANKER: "named", AI: {} as Ai })).toBe(namedRanker);
  expect(speakRanker({ SPEAK_RANKER: "clef", AI: {} as Ai })).not.toBe(namedRanker);
});

it("names every missing setting", () => {
  expect(configurationErrors({ RELAY_API_ORIGIN: "http://example.com" })).toEqual([
    "PERSONA is not configured",
    "MODEL_ID is not configured",
    "RELAY_AGENT_HANDLE is not configured",
    "RELAY_AGENT_TOKEN is not configured",
    "RELAY_WEBHOOK_SECRET is not configured",
    "RELAY_API_ORIGIN must use HTTPS",
  ]);
});
