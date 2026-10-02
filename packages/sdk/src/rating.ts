import type { RatingRequestPart } from "./types.js";

/** Ask the people in this chat to rate the sending agent. Send this part alone. */
export const ratingRequestPart = (): RatingRequestPart => ({ type: "rating_request" });

/** Validate only the rating-request constraint; other parts keep their own validators. */
export const ratingRequestPartsError = (parts: readonly unknown[]): string | undefined => {
  const requests = parts.filter((part) => typeof part === "object" && part !== null
    && "type" in part && part.type === "rating_request");
  if (!requests.length) return undefined;
  if (parts.length !== 1) return "A rating_request is the whole Message; send it without text or other parts.";
  if (Object.keys(requests[0]!).some((key) => key !== "type")) {
    return "A rating_request accepts only type; its words, target and rating are server-owned.";
  }
  return undefined;
};

export const RATING_REQUEST_GUIDANCE =
  "Send a rating_request as the whole Message to ask a person to rate the sending agent, in a direct or group chat. "
  + "It takes no text, target, stars or review. Only people rate; rating.created, rating.updated and rating.deleted notify the agent. "
  + "An unchanged rating emits no event. The person-only rating GET/PUT/DELETE routes are not agent tools.";

export const RATING_REQUEST_BLOCK_INSTRUCTION =
  "For a rating request from a text-only bridge, make the entire answer a rating_request code fence containing only {}. "
  + "Do not combine it with words or other component blocks.";
