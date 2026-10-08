import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { expect, it } from "vitest";

import { withEveryGroupMessage } from "../src/every-group-message";

function adapter() {
  return withEveryGroupMessage({ parseMessage: () => ({ isMention: false }) } as unknown as RelayAdapter);
}

const raw = (isGroup: boolean, eventType = "message.received") =>
  ({ eventType, message: { chat: { is_group: isGroup } } }) as unknown as Parameters<RelayAdapter["parseMessage"]>[0];

it("marks every group Message as addressed to the agent", () => {
  expect(adapter().parseMessage(raw(true)).isMention).toBe(true);
});

it("leaves direct Messages and other events alone", () => {
  expect(adapter().parseMessage(raw(false)).isMention).toBe(false);
  expect(adapter().parseMessage(raw(true, "message.sent")).isMention).toBe(false);
});
