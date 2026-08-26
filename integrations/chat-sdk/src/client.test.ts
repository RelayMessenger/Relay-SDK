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
      new Response(
        JSON.stringify({ message_id: "msg_out", message: { id: "msg_out" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  } as typeof fetch;
}

const sendOnce = (client: RelayClient) =>
  client.send({
    conversationId: "cnv_1",
    parts: [{ type: "text", text: "hi" }],
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

describe("RelayClient.send", () => {
  function recordingClient(): { client: RelayClient; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const fetchMock = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({ message_id: "msg_out", message: { id: "msg_out" } }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    return {
      client: new RelayClient({ token: "rly_live_test", fetch: fetchMock }),
      bodies,
    };
  }

  it("mints a msg_ ULID per send and carries no idempotency header", async () => {
    // The minted id IS the idempotency mechanism now: the same id is a replay
    // and another sender's id is a 409, so there is no header to send.
    const { client, bodies } = recordingClient();
    await client.send({ conversationId: "cnv_1", parts: [{ type: "text", text: "hi" }] });
    const body = bodies[0] as { message_id: string };
    expect(body.message_id).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("reuses a caller-supplied message id, so a retry replays instead of posting twice", async () => {
    const { client, bodies } = recordingClient();
    const messageId = "msg_01k1m9x2ph4vb7k0d3wzr8ftqe";
    await client.send({ conversationId: "cnv_1", messageId, parts: [{ type: "text", text: "hi" }] });
    await client.send({ conversationId: "cnv_1", messageId, parts: [{ type: "text", text: "hi" }] });
    expect(bodies.map((body) => (body as { message_id: string }).message_id)).toEqual([
      messageId,
      messageId,
    ]);
  });

  it("sorts two ids minted in the same millisecond in the order they were made", async () => {
    // Relay orders by id where timestamps tie, so a reply that overflows into
    // several messages must not shuffle.
    const { client, bodies } = recordingClient();
    await client.send({ conversationId: "cnv_1", parts: [{ type: "text", text: "one" }] });
    await client.send({ conversationId: "cnv_1", parts: [{ type: "text", text: "two" }] });
    const [first, second] = bodies.map((body) => (body as { message_id: string }).message_id);
    expect(first! < second!).toBe(true);
  });

  it("maps a reply target into the pointer wire shape", async () => {
    const { client, bodies } = recordingClient();
    await client.send({
      conversationId: "cnv_1",
      parts: [{ type: "text", text: "hi" }],
      replyTo: { messageId: "msg_9", partId: "prt_3" },
    });
    expect(bodies[0]).toMatchObject({
      reply_to: { message_id: "msg_9", part_id: "prt_3" },
    });
  });
});
