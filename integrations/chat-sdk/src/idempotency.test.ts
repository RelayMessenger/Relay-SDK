import { describe, expect, it } from "vitest";
import {
  DedupeWindow,
  deriveIdempotencyKey,
  unkeyedIdempotencyKey,
} from "./idempotency.js";

describe("deriveIdempotencyKey", () => {
  it("is stable for the same event and ordinal", () => {
    expect(deriveIdempotencyKey("evt_1", 0)).toBe(deriveIdempotencyKey("evt_1", 0));
  });

  it("ignores the content, so Relay can replay a retry and refuse a diverging one", () => {
    // Relay hashes the whole request server side and stores it beside the key
    // (commitMessage.ts:1553-1561), then replays the stored response for a
    // matching hash and answers 409 idempotency_conflict for a different one
    // (:1885-1887). A key that moved with the content would make that conflict
    // unreachable, so an LLM that wrote different words on the retry would post
    // a genuine second message to the person.
    expect(deriveIdempotencyKey("evt_1", 0)).toBe("relay:evt_1:0");
  });

  it("changes with the ordinal and with the event", () => {
    expect(deriveIdempotencyKey("evt_1", 0)).not.toBe(deriveIdempotencyKey("evt_1", 1));
    expect(deriveIdempotencyKey("evt_1", 0)).not.toBe(deriveIdempotencyKey("evt_2", 0));
  });

  it("stays inside Relay's 8 to 255 character bound", () => {
    for (const eventId of ["", "e", "e".repeat(400)]) {
      const key = deriveIdempotencyKey(eventId, 3);
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key.length).toBeLessThanOrEqual(255);
    }
  });
});

describe("unkeyedIdempotencyKey", () => {
  it("is unique per call, because there is no event to replay against", () => {
    expect(unkeyedIdempotencyKey("cnv_1")).not.toBe(unkeyedIdempotencyKey("cnv_1"));
  });
});

describe("DedupeWindow", () => {
  it("remembers what it claimed", () => {
    const window = new DedupeWindow(4);
    expect(window.has("evt_1")).toBe(false);
    expect(window.claim("evt_1")).toBe(true);
    expect(window.has("evt_1")).toBe(true);
  });

  it("refuses a second claim on one event id", () => {
    const window = new DedupeWindow(4);
    expect(window.claim("evt_1")).toBe(true);
    expect(window.claim("evt_1")).toBe(false);
  });

  it("lets a released event id be claimed again", () => {
    const window = new DedupeWindow(4);
    window.claim("evt_1");
    window.release("evt_1");
    expect(window.claim("evt_1")).toBe(true);
  });

  it("evicts the oldest entry past capacity", () => {
    const window = new DedupeWindow(2);
    window.claim("a");
    window.claim("b");
    window.claim("c");
    expect(window.has("a")).toBe(false);
    expect(window.has("c")).toBe(true);
  });
});
