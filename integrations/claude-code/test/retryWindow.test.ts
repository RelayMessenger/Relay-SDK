import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RetryWindow } from "../src/retryWindow.ts";

describe("unacknowledged notification retry window", () => {
  it("suppresses only for a bounded interval, then retries in the same process", () => {
    let now = 1_000;
    const window = new RetryWindow(30_000, () => now);
    assert.equal(window.shouldAttempt("evt_1"), true);
    window.recordAttempt("evt_1");
    now += 29_999;
    assert.equal(window.shouldAttempt("evt_1"), false);
    now += 1;
    assert.equal(window.shouldAttempt("evt_1"), true);
  });

  it("explicit acknowledgement clears suppression state", () => {
    const window = new RetryWindow(30_000, () => 1_000);
    window.recordAttempt("evt_1");
    assert.equal(window.shouldAttempt("evt_1"), false);
    window.clear("evt_1");
    assert.equal(window.shouldAttempt("evt_1"), true);
  });
});
