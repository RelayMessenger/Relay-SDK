import { RELAY_USER_ID_CLAIM, type RelayIdTokenClaims } from "@relaymessenger/sdk";

declare const claims: RelayIdTokenClaims;
// The person's Relay id is a typed string claim, not JWTPayload's unknown.
const relayUserId: string | undefined = claims[RELAY_USER_ID_CLAIM];
const literalKey: string | undefined = claims["https://relayapp.im/user_id"];
void relayUserId;
void literalKey;
