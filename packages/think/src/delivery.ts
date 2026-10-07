import type { MessengerDeliveryPolicy } from "@cloudflare/think/messengers";

/**
 * The delivery policy for Think's Relay messenger (`chatSdkMessenger({ delivery })`).
 * Think posts the model's plain reply text to the chat after the turn
 * (@cloudflare/think deliverMessengerReply). A Relay agent's Messages are its
 * `send` calls, each paced and keyed, so that text must never become a Message
 * of its own: a soft limit of 0 shows none of it, splitText posts no rest, and
 * the fallback texts are empty, which the Relay adapter sends as nothing.
 */
export const RELAY_MESSENGER_DELIVERY: MessengerDeliveryPolicy = {
  emptyResponseText: "",
  errorResponseText: "",
  interruptedResponseText: "",
  splitText: () => [],
  visibleSoftLimit: 0,
};
