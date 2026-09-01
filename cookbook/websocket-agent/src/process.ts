import Relay from "@relaymessenger/sdk";
import { homedir } from "node:os";
import { join } from "node:path";

import { InboxProcessor } from "./processor.js";
import { accountScope, relayApiOrigin } from "./config.js";
import { createSocketCallbacks } from "./runner.js";
import { RelayStore } from "./store.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const token = requiredEnvironment("RELAY_AGENT_TOKEN");
const origin = relayApiOrigin(process.env.RELAY_API_URL);
const relay = new Relay({
  apiKey: token,
  baseURL: origin,
});
const store = new RelayStore(
  process.env.RELAY_STATE_PATH?.trim()
    || join(homedir(), ".relay", "examples", "websocket", "state.db"),
  accountScope(origin, token),
);
const processor = new InboxProcessor(store, relay);
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
