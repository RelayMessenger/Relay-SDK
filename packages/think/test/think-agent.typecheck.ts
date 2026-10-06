/// <reference path="../../../cookbook/cloudflare-think-agent/worker-configuration.d.ts" />
// Compiled by `npm run check`, never run: the README's usage, against the real
// Think class and the real Worker types (the cookbook's wrangler-generated
// ones). A Durable Object's env is protected, so this fails to compile if
// relayActions ever asks for the agent's env through the agent itself.
import { Think, action } from "@cloudflare/think";
import { z } from "zod";

import { relayActions } from "../src/actions";

const myOwnTools = {
  lookup_order: action({
    description: "Look up an order.",
    inputSchema: z.object({ id: z.string() }).strict(),
    execute: async ({ id }) => ({ id }),
  }),
};

export class ReadmeAgent extends Think<Cloudflare.Env> {
  override getActions() {
    return { ...relayActions(this.env, this), ...myOwnTools };
  }
}
