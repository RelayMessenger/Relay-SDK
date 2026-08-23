import { RelayApiError } from "./client.js";
import type { RelayClient } from "./client.js";
import type { RelayInboundFacts } from "./inbound.js";

/**
 * Record the read/responding receipt, then commit the durable attempt marker.
 *
 * The receipt is a courtesy to the person waiting: it turns their message Read
 * and shows that something is composing. It is NOT permission to answer, and
 * it used to be treated as such — a rejected receipt threw here, before
 * `markAttempt`, which sent the poll loop down its replay branch and froze the
 * channel's single delivery cursor. One group mention whose receipt the server
 * refused therefore starved every later message, direct ones included
 * (REL-167).
 *
 * So a failed receipt is reported and the turn continues. The ordering that
 * mattered is kept: the receipt is still attempted BEFORE the attempt marker,
 * so a receipt that succeeds still precedes any agent or tool work.
 */
export async function markRespondingBeforeAttempt(params: {
  client: RelayClient;
  /**
   * The whole fact bundle, not its fields one at a time. The receipt needs the
   * conversation, the message, AND the invocation when there is one, and a
   * caller that copies two of those three out by hand can silently forget the
   * third — which is how the group receipt shipped without its invocation id.
   */
  facts: Pick<RelayInboundFacts, "conversationId" | "messageId" | "invocationId">;
  label: string;
  markAttempt: () => Promise<void>;
  onReceiptFailure?: (line: string) => void;
}): Promise<void> {
  const { facts } = params;
  try {
    await params.client.setResponding({
      conversationId: facts.conversationId,
      messageId: facts.messageId,
      label: params.label,
      ...(facts.invocationId ? { invocationId: facts.invocationId } : {}),
    });
  } catch (error) {
    // An aborted shutdown is not a receipt failure; let it settle the loop.
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    const detail = error instanceof RelayApiError ? error.message : String(error);
    params.onReceiptFailure?.(
      `responding receipt for message ${facts.messageId} failed, answering anyway: ${detail}`,
    );
  }
  await params.markAttempt();
}
