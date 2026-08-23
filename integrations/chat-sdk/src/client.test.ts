import { afterEach, describe, expect, it } from "vitest";

import { RelayClient } from "./client.js";

/**
 * Stands in for a runtime that enforces fetch's receiver. workerd throws
 * `TypeError: Illegal invocation` when the global fetch is called with any
 * `this` other than the global object; undici, which backs Node, ignores the
 * receiver entirely. A Node-only suite therefore cannot observe the difference
 * unless the stub asserts the receiver itself, which is what this does.
 */
function strictFetch(): typeof fetch {
  return function (this: unknown) {
    if (this !== globalThis && this !== undefined) {
      throw new TypeError(
        "Illegal invocation: function called with incorrect this reference.",
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "msg_out" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  } as typeof fetch;
}

const sendOnce = (client: RelayClient) =>
  client.send({
    conversationId: "cnv_1",
    parts: [{ type: "text", text: "hi" }],
    idempotencyKey: "relay:evt_1:0",
  });

describe("RelayClient fetch binding", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("calls the default fetch with the global as its receiver", async () => {
    // The failure this guards shipped in 0.2.0: every request from a Cloudflare
    // Worker threw before leaving the isolate, because the client held the
    // global fetch on a property and invoked it as a method of itself.
    globalThis.fetch = strictFetch();
    const client = new RelayClient({ token: "rly_live_test" });

    await expect(sendOnce(client)).resolves.toBeDefined();
  });

  it("does not hand a caller-supplied fetch the client as its receiver", async () => {
    // Passing the bare global in as an option is the documented workaround for
    // the 0.2.0 defect, so it has to survive the same receiver check.
    const client = new RelayClient({ token: "rly_live_test", fetch: strictFetch() });

    await expect(sendOnce(client)).resolves.toBeDefined();
  });
});
