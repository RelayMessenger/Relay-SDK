import { describe, expect, it } from "vitest";
import {
  DedupeWindow,
  canonicalJson,
  deriveIdempotencyKey,
  unkeyedIdempotencyKey,
} from "./idempotency.js";

describe("deriveIdempotencyKey", () => {
  const parts = [{ type: "text", text: "hello" }];

  it("is stable for the same event, ordinal, and content", async () => {
    const first = await deriveIdempotencyKey("evt_1", 0, parts);
    const second = await deriveIdempotencyKey("evt_1", 0, parts);
    expect(first).toBe(second);
  });

  it("ignores key order inside the content", async () => {
    const a = await deriveIdempotencyKey("evt_1", 0, [{ type: "text", text: "hi" }]);
    const b = await deriveIdempotencyKey("evt_1", 0, [{ text: "hi", type: "text" }]);
    expect(a).toBe(b);
  });

  it("changes when the content changes, so a diverging retry cannot 409", async () => {
    const first = await deriveIdempotencyKey("evt_1", 0, parts);
    const second = await deriveIdempotencyKey("evt_1", 0, [
      { type: "text", text: "different" },
    ]);
    expect(first).not.toBe(second);
  });

  it("changes with the ordinal and with the event", async () => {
    expect(await deriveIdempotencyKey("evt_1", 0, parts)).not.toBe(
      await deriveIdempotencyKey("evt_1", 1, parts),
    );
    expect(await deriveIdempotencyKey("evt_1", 0, parts)).not.toBe(
      await deriveIdempotencyKey("evt_2", 0, parts),
    );
  });

  it("stays inside Relay's 8 to 255 character bound", async () => {
    const key = await deriveIdempotencyKey("e".repeat(400), 3, parts);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(255);
  });
});

describe("unkeyedIdempotencyKey", () => {
  it("is unique per call, because there is no event to replay against", () => {
    expect(unkeyedIdempotencyKey("cnv_1")).not.toBe(unkeyedIdempotencyKey("cnv_1"));
  });
});

describe("canonicalJson", () => {
  it("drops undefined members and sorts keys", () => {
    expect(canonicalJson({ b: 1, a: undefined, c: [2, { e: 3, d: 4 }] })).toBe(
      '{"b":1,"c":[2,{"d":4,"e":3}]}',
    );
  });
});

describe("DedupeWindow", () => {
  it("remembers what it recorded", () => {
    const window = new DedupeWindow(4);
    expect(window.has("evt_1")).toBe(false);
    window.record("evt_1");
    expect(window.has("evt_1")).toBe(true);
  });

  it("evicts the oldest entry past capacity", () => {
    const window = new DedupeWindow(2);
    window.record("a");
    window.record("b");
    window.record("c");
    expect(window.has("a")).toBe(false);
    expect(window.has("c")).toBe(true);
  });
});
