import { describe, expect, it } from "vitest";
import { DedupeWindow } from "./dedupe.js";

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
