import { action, type Action } from "@cloudflare/think";

import type { RelayTurnIdentity } from "../actions.js";
import type { RelayGenerationActivities } from "../activity.js";
import { createRelayClient, type RelayClientEnv } from "../typing.js";
import {
  SEARCH_SOURCES_DESCRIPTION,
  searchSources,
  searchSourcesInputSchema,
  type SearchSourcesEnv,
} from "./search-sources.js";

/** Dependencies required to register the `search_sources` Think Action. */
export interface SearchSourcesActionDependencies {
  env: SearchSourcesEnv & RelayClientEnv;
  activities: RelayGenerationActivities;
  turn(): RelayTurnIdentity;
  signal(platformSignal?: AbortSignal): AbortSignal | undefined;
  assertCurrentTurn(identity: RelayTurnIdentity): void;
  waitUntil(task: Promise<void>): void;
}

/** Register the `search_sources` Action when a `CLONE_INDEX` binding is present. */
export function searchSourcesActions(deps: SearchSourcesActionDependencies): Record<string, Action> {
  if (!deps.env.CLONE_INDEX) return {};
  return {
    search_sources: action({
      description: SEARCH_SOURCES_DESCRIPTION,
      inputSchema: searchSourcesInputSchema,
      execute: async (input, context) => {
        const identity = deps.turn();
        const signal = deps.signal(context.signal);
        const assertCurrent = () => {
          signal?.throwIfAborted();
          deps.assertCurrentTurn(identity);
        };
        assertCurrent();
        const activity = deps.activities.start(
          createRelayClient(deps.env).chats,
          identity.chatId,
          { text: input.activity, emoji: null },
          assertCurrent,
          (task) => deps.waitUntil(task),
        );
        try {
          return await searchSources(deps.env, input.query, signal);
        } finally {
          await activity.stop();
        }
      },
    }),
  };
}
