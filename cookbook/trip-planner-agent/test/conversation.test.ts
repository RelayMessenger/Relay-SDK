import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderPlanParts, type PlanRequest, type TripPlan } from "../src/plan.js";
import { processAcceptedEvent, type RelayChatClient } from "../src/processor.js";
import { TripStore } from "../src/store.js";
import { BOB, CHAT, inboundEvent, PLAN } from "./fixtures.js";

const REVISED: TripPlan = {
  ...PLAN,
  dates: "12-13 June",
  days: [{ label: "Day 1 - Friday 12 June", items: ["Land at midday"] }],
};

function relayDouble() {
  const send = vi.fn().mockResolvedValue({});
  const markAsRead = vi.fn().mockResolvedValue(undefined);
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const stopTyping = vi.fn().mockResolvedValue(undefined);
  const relay: RelayChatClient = {
    chats: { markAsRead, messages: { send }, startTyping, stopTyping },
  };
  return { markAsRead, relay, send, startTyping, stopTyping };
}

const ASK = inboundEvent({
  eventId: "01993d50-ef7b-7b37-886b-23fd80c7ed01",
  isGroup: true,
  mention: "@tripplanner",
  messageId: "01993d50-ef7b-7b37-886b-23fd80c7ed11",
  text: "@tripplanner three days in Lisbon in June, 800 each",
});

const ASIDE = inboundEvent({
  eventId: "01993d50-ef7b-7b37-886b-23fd80c7ed02",
  isGroup: true,
  messageId: "01993d50-ef7b-7b37-886b-23fd80c7ed12",
  sender: BOB,
  text: "I can only do the 12th and the 13th",
});

const CHANGE = inboundEvent({
  eventId: "01993d50-ef7b-7b37-886b-23fd80c7ed03",
  isGroup: true,
  mention: "@tripplanner",
  messageId: "01993d50-ef7b-7b37-886b-23fd80c7ed13",
  text: "@tripplanner redo it for those two days",
});

describe("planning a trip in a group Chat", () => {
  let store: TripStore;

  beforeEach(() => {
    store = new TripStore(":memory:", "test-scope");
  });

  it("stays silent on an unmentioned message but remembers it", async () => {
    const { markAsRead, relay, send, startTyping } = relayDouble();
    const plan = vi.fn();

    await processAcceptedEvent({ memory: store, planner: { plan }, relay }, ASIDE);

    expect(send).not.toHaveBeenCalled();
    expect(startTyping).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(markAsRead).toHaveBeenCalledWith(CHAT);
    expect(store.thread(CHAT)).toEqual([
      { author: "Bob", text: "I can only do the 12th and the 13th" },
    ]);
  });

  it("updates the plan when somebody changes a constraint", async () => {
    const { relay, send, startTyping, stopTyping } = relayDouble();
    const requests: PlanRequest[] = [];
    const plan = vi.fn(async (request: PlanRequest): Promise<TripPlan> => {
      requests.push(structuredClone(request));
      return requests.length === 1 ? PLAN : REVISED;
    });
    const dependencies = { memory: store, planner: { plan }, relay };

    await processAcceptedEvent(dependencies, ASK);
    await processAcceptedEvent(dependencies, ASIDE);
    await processAcceptedEvent(dependencies, CHANGE);

    // The second turn sees the plan it already agreed, and the unmentioned
    // message that changed the dates.
    expect(requests[1]?.previous).toEqual(PLAN);
    expect(requests[1]?.thread).toEqual([
      { author: "Alice", text: "@tripplanner three days in Lisbon in June, 800 each" },
      { author: "Bob", text: "I can only do the 12th and the 13th" },
      { author: "Alice", text: "@tripplanner redo it for those two days" },
    ]);

    // It answers the message that changed the constraint, quoting it.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(CHAT, {
      message: {
        parts: renderPlanParts(REVISED),
        reply_to: { message_id: CHANGE.data.id },
        idempotency_key: `relay-example:trip-planner:${CHANGE.event_id}`,
      },
    });
    expect(startTyping).toHaveBeenCalledTimes(2);
    expect(stopTyping).toHaveBeenCalledTimes(2);
    expect(store.currentPlan(CHAT)).toEqual(REVISED);
  });

  it("asks the model once per event, even when the send is retried", async () => {
    const { relay, send } = relayDouble();
    send.mockRejectedValueOnce(new Error("503 from Relay"));
    const plan = vi.fn().mockResolvedValue(PLAN);
    const dependencies = { memory: store, planner: { plan }, relay };

    await expect(processAcceptedEvent(dependencies, ASK)).rejects.toThrow("503");
    await processAcceptedEvent(dependencies, ASK);

    expect(plan).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(2, CHAT, send.mock.calls[0]?.[1]);
  });
});
