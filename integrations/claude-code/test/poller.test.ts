import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startPoller } from "../src/poller.ts";
import { RelayApiError, type RelayClient } from "../src/relayClient.ts";

describe("poller authentication failures", () => {
  it("stops after a terminal 401 instead of retrying forever", async () => {
    let polls = 0;
    let sleeps = 0;
    const logs: string[] = [];
    const client = {
      async pollEvents(): Promise<never> {
        polls += 1;
        throw new RelayApiError(401, "unauthorized", "token rejected");
      },
    } as unknown as RelayClient;

    const poller = startPoller({
      client,
      getCursor: () => 0,
      setCursor: () => {},
      onEvent: async () => {},
      log: (line) => logs.push(line),
      sleep: async () => {
        sleeps += 1;
      },
    });
    await poller.done;

    assert.equal(polls, 1);
    assert.equal(sleeps, 0);
    assert.ok(logs.some((line) => line.includes("stopping channel")));
  });
});
