import { beforeEach, describe, expect, it } from "vitest";
import {
  relayInvocationFor,
  rememberRelayInvocation,
  resetRelayInvocationsForTest,
} from "./invocations.js";

const account = "default";

describe("relay invocation registry", () => {
  beforeEach(() => {
    resetRelayInvocationsForTest();
  });

  it("hands the turn's invocation to a send in the same conversation", () => {
    rememberRelayInvocation({
      accountId: account,
      conversationId: "cnv_group",
      invocationId: "inv_1",
    });
    expect(relayInvocationFor({ accountId: account, conversationId: "cnv_group" }))
      .toBe("inv_1");
  });

  it("tells a different conversation nothing", () => {
    rememberRelayInvocation({
      accountId: account,
      conversationId: "cnv_group",
      invocationId: "inv_1",
    });
    expect(relayInvocationFor({ accountId: account, conversationId: "cnv_other" }))
      .toBeUndefined();
  });

  // Two agents can be mentioned in one group and each gets its own invocation.
  // Sharing a slot by conversation alone would send one agent's id on the
  // other's reply, which the server refuses.
  it("keeps two accounts in one conversation apart", () => {
    rememberRelayInvocation({
      accountId: "agent_a",
      conversationId: "cnv_group",
      invocationId: "inv_a",
    });
    rememberRelayInvocation({
      accountId: "agent_b",
      conversationId: "cnv_group",
      invocationId: "inv_b",
    });
    expect(relayInvocationFor({ accountId: "agent_a", conversationId: "cnv_group" }))
      .toBe("inv_a");
    expect(relayInvocationFor({ accountId: "agent_b", conversationId: "cnv_group" }))
      .toBe("inv_b");
  });

  it("clears the slot when the turn releases it", () => {
    const release = rememberRelayInvocation({
      accountId: account,
      conversationId: "cnv_group",
      invocationId: "inv_1",
    });
    release();
    expect(relayInvocationFor({ accountId: account, conversationId: "cnv_group" }))
      .toBeUndefined();
  });

  it("does not let a superseded turn delete its successor's invocation", () => {
    const releaseFirst = rememberRelayInvocation({
      accountId: account,
      conversationId: "cnv_group",
      invocationId: "inv_1",
    });
    rememberRelayInvocation({
      accountId: account,
      conversationId: "cnv_group",
      invocationId: "inv_2",
    });
    releaseFirst();
    expect(relayInvocationFor({ accountId: account, conversationId: "cnv_group" }))
      .toBe("inv_2");
  });
});
