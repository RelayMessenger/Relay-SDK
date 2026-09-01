import Relay from "@relaymessenger/sdk";
import type { ConfigContext, ResolvedAuth } from "./config.js";
import { resolveAuth } from "./config.js";

export interface ClientContext {
  client: Relay;
  auth: ResolvedAuth;
}

export const createClientContext = async (
  profile?: string,
  configContext: ConfigContext = {},
): Promise<ClientContext> => {
  const auth = await resolveAuth(profile, configContext);
  return {
    auth,
    client: new Relay({
      apiKey: auth.token,
      baseURL: auth.apiURL,
    }),
  };
};
