import Anthropic from "@anthropic-ai/sdk";

import type { PlanRequest, TripPlan, TripPlanner } from "./plan.js";

export const MODEL_ID = "claude-sonnet-5";

const SYSTEM = [
  "You plan trips for a group chat. You read the whole conversation and keep",
  "one plan for the group.",
  "",
  "Rules:",
  "- Use only what the conversation says. You have no search, no calendar and",
  "  no booking system, so never invent a price, an opening time, a flight",
  "  number or an address.",
  "- Anything the group has not settled goes in open_questions, written as a",
  "  question you are asking them. Leave the matching field as",
  "  \"not decided yet\" rather than guessing.",
  "- When a previous plan is given, keep every part the group still agrees",
  "  with and change only what the newest messages changed.",
  "- Each day's items are short lines a person can read on a phone.",
].join("\n");

/**
 * output_config.format makes the API return exactly this shape, so no
 * response parsing or repair loop is needed.
 */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    destination: { type: "string" },
    dates: { type: "string" },
    travelers: { type: "array", items: { type: "string" } },
    budget: { type: "string" },
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          items: { type: "array", items: { type: "string" } },
        },
        required: ["label", "items"],
        additionalProperties: false,
      },
    },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: [
    "destination",
    "dates",
    "travelers",
    "budget",
    "days",
    "open_questions",
  ],
  additionalProperties: false,
} as const;

function prompt({ previous, thread }: PlanRequest): string {
  const conversation = thread
    .map(({ author, text }) => `${author}: ${text}`)
    .join("\n");
  const priorPlan = previous
    ? `The plan this group already has:\n${JSON.stringify(previous, null, 2)}\n\n`
    : "";
  return `${priorPlan}The conversation so far:\n${conversation}\n\n`
    + "Write the group's trip plan now.";
}

/**
 * The model seam. Replace this function to use another provider; nothing
 * else in the example knows which model wrote the plan.
 */
export function anthropicPlanner(
  client: Anthropic = new Anthropic(),
): TripPlanner {
  return {
    async plan(request: PlanRequest): Promise<TripPlan> {
      const response = await client.messages.create({
        model: MODEL_ID,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        messages: [{ role: "user", content: prompt(request) }],
        output_config: {
          format: { type: "json_schema", schema: PLAN_SCHEMA },
        },
      });
      if (response.stop_reason === "refusal") {
        throw new Error("The model declined to write this plan");
      }
      const text = response.content.find((block) => block.type === "text");
      if (!text) throw new Error("The model returned no plan");
      return JSON.parse(text.text) as TripPlan;
    },
  };
}
