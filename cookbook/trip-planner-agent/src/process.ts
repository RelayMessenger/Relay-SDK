import Relay from "@relaymessenger/sdk";
import { homedir } from "node:os";
import { join } from "node:path";

import { accountScope, relayApiOrigin, requiredEnvironment } from "./config.js";
import { InboxProcessor } from "./inbox.js";
import { anthropicPlanner } from "./model.js";
import { createSocketCallbacks } from "./runner.js";
import { TripStore } from "./store.js";

const token = requiredEnvironment("RELAY_AGENT_TOKEN");
requiredEnvironment("ANTHROPIC_API_KEY");
const origin = relayApiOrigin(process.env.RELAY_API_URL);

const relay = new Relay({ apiKey: token, baseURL: origin });
const store = new TripStore(
  process.env.RELAY_STATE_PATH?.trim()
    || join(homedir(), ".relay", "examples", "trip-planner", "state.db"),
  accountScope(origin, token),
);
const processor = new InboxProcessor(store, {
  memory: store,
  planner: anthropicPlanner(),
  relay,
});
const abort = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abort.abort());
}

processor.start();
try {
  await relay.websocket.run({
    signal: abort.signal,
    ...createSocketCallbacks(relay, store, () => processor.wake()),
    onError: (error) => {
      console.error(JSON.stringify({
        event: "relay_websocket_reconnect",
        error: error instanceof Error ? error.message : String(error),
      }));
    },
  });
} finally {
  processor.stop();
  store.close();
}
