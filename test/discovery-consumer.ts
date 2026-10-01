import Relay, {
  RELAY_USER_ID_CLAIM,
  type AgentRatingSetParams,
  type RelayIdTokenClaims,
  type SuggestedAgent,
} from "@relaymessenger/sdk";

declare const claims: RelayIdTokenClaims;
// The person's Relay id is a typed string claim, not JWTPayload's unknown.
const relayUserId: string | undefined = claims[RELAY_USER_ID_CLAIM];
const literalKey: string | undefined = claims["https://relayapp.im/user_id"];
void relayUserId;
void literalKey;

const relay = new Relay({ apiKey: "fixture-token" });
const stars: AgentRatingSetParams = { stars: 5, review: null };
void relay.ratings.set("brave_cangoo", stars);
// @ts-expect-error Stars run from one to five.
void relay.ratings.set("brave_cangoo", { stars: 6 });
void relay.agents.listSuggested({ limit: 7, contacts: "lupe:3" });
void relay.addressBook.countAgents({ phone_hashes: [] });
void relay.agentRequests.create({ query: "tenant lawyer", what: "Read my lease" });
// @ts-expect-error An agent request needs what the agent should help with.
void relay.agentRequests.create({ query: "tenant lawyer" });

declare const suggested: SuggestedAgent;
// @ts-expect-error A suggestion's reason is one of three.
const reason: "nearby" = suggested.reason;
void reason;
