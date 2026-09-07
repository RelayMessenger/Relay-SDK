import type { MessagePart } from "@relaymessenger/sdk";

/** One line of conversation the planner is allowed to read. */
export interface ThreadMessage {
  author: string;
  text: string;
}

export interface TripDay {
  /** "Day 1 - Friday 12 June", or whatever the conversation supports. */
  label: string;
  items: string[];
}

export interface TripPlan {
  destination: string;
  dates: string;
  travelers: string[];
  budget: string;
  days: TripDay[];
  /** Constraints nobody has settled yet. Asked, never invented. */
  open_questions: string[];
}

export interface PlanRequest {
  thread: ThreadMessage[];
  /** The plan this Chat already agreed, when there is one. */
  previous: TripPlan | null;
}

export interface TripPlanner {
  plan(request: PlanRequest): Promise<TripPlan>;
}

/** Relay accepts 1-100 parts, each 1-10000 characters. */
const MAX_PARTS = 100;
const MAX_PART_LENGTH = 10_000;

const clamp = (value: string): string =>
  value.length <= MAX_PART_LENGTH ? value : `${value.slice(0, MAX_PART_LENGTH - 1)}…`;

const line = (label: string, value: string): string =>
  `${label}: ${value.trim() || "not decided yet"}`;

/**
 * One ordered text part per section: the summary, then one part per day,
 * then anything the group still has to decide. Relay renders the parts in
 * order inside a single Message.
 */
export function renderPlanParts(plan: TripPlan): MessagePart[] {
  const summary = [
    `Trip to ${plan.destination.trim() || "somewhere we have not picked"}`,
    line("When", plan.dates),
    line("Who", plan.travelers.join(", ")),
    line("Budget", plan.budget),
  ].join("\n");

  const days = plan.days.map((day) =>
    [day.label, ...day.items.map((item) => `- ${item}`)].join("\n")
  );

  const questions = plan.open_questions.length > 0
    ? [["Still to decide", ...plan.open_questions.map((q) => `- ${q}`)].join("\n")]
    : [];

  const sections = [summary, ...days, ...questions]
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .slice(0, MAX_PARTS);

  return sections.map((value) => ({ type: "text", value: clamp(value) }));
}
