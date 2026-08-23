/**
 * Which group invocation an in-flight turn belongs to.
 *
 * Relay mints an invocation when a human invokes an agent in a group, and
 * every call the agent then makes about that message has to carry the id back:
 * `/typing` and `/responding` refuse without it, and so does the reply itself.
 *
 * The reply does not leave through this plugin's own code. It leaves through
 * core's durable message adapter, whose send context carries `to`, `text`, and
 * delivery bookkeeping and nothing about the message being answered
 * (`ChannelMessageSendTextContext`). There is no field to thread the id
 * through, so the turn parks it here for the adapter to find.
 *
 * Keyed by (accountId, conversationId) because `to` and `accountId` are all
 * the adapter knows. Two agents in one group get separate slots. Two
 * overlapping turns for ONE agent in ONE group share a slot and the later one
 * wins — bounded by the server, which spends an invocation exactly once and
 * refuses the loser rather than misattributing it.
 */
const pendingInvocations = new Map<string, string>();

function slotKey(accountId: string, conversationId: string): string {
  return `${accountId}\0${conversationId}`;
}

/**
 * Hold `invocationId` for the life of one turn. Returns the release function;
 * call it in a `finally` so a thrown turn cannot strand the slot.
 *
 * Releasing only clears the slot if this turn still owns it, so a turn that
 * finishes after being superseded cannot delete its successor's id.
 */
export function rememberRelayInvocation(params: {
  accountId: string;
  conversationId: string;
  invocationId: string;
}): () => void {
  const key = slotKey(params.accountId, params.conversationId);
  pendingInvocations.set(key, params.invocationId);
  return () => {
    if (pendingInvocations.get(key) === params.invocationId) {
      pendingInvocations.delete(key);
    }
  };
}

/** The invocation an outbound send in this conversation belongs to, if any. */
export function relayInvocationFor(params: {
  accountId: string;
  conversationId: string;
}): string | undefined {
  return pendingInvocations.get(slotKey(params.accountId, params.conversationId));
}

/** Test seam: drop every slot. */
export function resetRelayInvocationsForTest(): void {
  pendingInvocations.clear();
}
