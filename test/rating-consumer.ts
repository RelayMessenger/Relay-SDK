import type { MessageContent, MessagePartResponse, RatingRequestPart, RatingEvent, RelayWebhookEvent } from "@relaymessenger/sdk";
import { ratingRequestPart } from "@relaymessenger/sdk";

const request: RatingRequestPart = ratingRequestPart();
const message: MessageContent = { parts: [request] };
const response: MessagePartResponse = { type: "rating_request", rating: { stars: 5, review: null }, reactions: null };
// @ts-expect-error Prompt words are not caller-owned.
const withTitle: RatingRequestPart = { type: "rating_request", title: "Rate me" };
// @ts-expect-error An agent cannot select somebody else's target.
const withTarget: RatingRequestPart = { type: "rating_request", handle: "someone" };
// @ts-expect-error Stars are only the person's answer, not an agent's request.
const withStars: RatingRequestPart = { type: "rating_request", stars: 5 };

export function receivedRating(event: RelayWebhookEvent): RatingEvent | null {
  if (event.event_type === "rating.created" || event.event_type === "rating.updated") {
    const stars: 1 | 2 | 3 | 4 | 5 = event.data.stars;
    const review: string | null = event.data.review;
    void stars; void review;
    return event.data;
  }
  if (event.event_type === "rating.deleted") {
    const person: string = event.data.contact.id;
    // @ts-expect-error A deletion carries only contact, no old stars.
    event.data.stars;
    void person;
  }
  return null;
}
void message; void response; void withTitle; void withTarget; void withStars;
