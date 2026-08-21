import type { RelayClient } from "./client.js";

/**
 * The receipt must commit before OpenClaw can run an agent or tool. A rejected
 * receipt leaves the durable attempt marker untouched, so the poll loop can
 * replay the event safely instead of hiding the failure after execution.
 */
export async function markRespondingBeforeAttempt(params: {
  client: RelayClient;
  conversationId: string;
  messageId: string;
  label: string;
  markAttempt: () => Promise<void>;
}): Promise<void> {
  await params.client.setResponding({
    conversationId: params.conversationId,
    messageId: params.messageId,
    label: params.label,
  });
  await params.markAttempt();
}
