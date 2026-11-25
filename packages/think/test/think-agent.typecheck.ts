// Compiled by `npm run check`, never run: the README's usage, against the real
// Think class and the real Worker types (wrangler-generated from
// wrangler.test.jsonc). A Durable Object's env and ctx are protected, so this
// fails to compile if relayActions ever reads them through the agent itself.
import { Think, action } from "@cloudflare/think";
import { z } from "zod";

import { relayActions } from "../src/actions";
import type { SearchSourcesEnv, SpeakGateEnv } from "../src/clone";

const myOwnTools = {
  lookup_order: action({
    description: "Look up an order.",
    inputSchema: z.object({ id: z.string() }).strict(),
    execute: async ({ id }) => ({ id }),
  }),
};

type ReadmeEnv = Cloudflare.Env & {
  RELAY_AGENT_TOKEN: string;
  RELAY_API_ORIGIN?: string;
  AI?: Ai;
  CLONE_INDEX?: VectorizeIndex;
};

export class ReadmeAgent extends Think<ReadmeEnv> {
  override getActions() {
    const speakEnv: SpeakGateEnv = this.env;
    const searchEnv: SearchSourcesEnv = this.env;
    void speakEnv;
    void searchEnv;
    return { ...relayActions(this, { env: this.env, ctx: this.ctx }), ...myOwnTools };
  }
}
