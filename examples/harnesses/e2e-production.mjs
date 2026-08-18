#!/usr/bin/env node
/**
 * Production smoke against api.relayapp.im using RELAY_AGENT_TOKEN.
 * Proves getMe + long-poll page fetch. Full message round-trip needs a user
 * text in the Relay app while showcase-agent is running.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadToken() {
  if (process.env.RELAY_AGENT_TOKEN?.trim()) return process.env.RELAY_AGENT_TOKEN.trim();
  try {
    // The repo's own gitignored .env; see README "Development".
    const envPath = join(root, ".env");
    const text = spawnSync("sed", ["-n", "s/^RELAY_AGENT_TOKEN=//p", envPath], {
      encoding: "utf8",
    });
    return text.stdout.trim();
  } catch {
    return "";
  }
}

const token = loadToken();
if (!token) {
  console.error("RELAY_AGENT_TOKEN required");
  process.exit(1);
}

const build = spawnSync("npm", ["run", "build", "-w", "@relaymessenger/core"], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const { createRelayClient } = await import(
  join(root, "packages/core/dist/index.js")
);

const client = createRelayClient({ token });
const me = await client.getMe();
console.log(`e2e: authenticated as @${me.handle} (${me.id})`);

const page = await client.pollEvents({ cursor: 0, timeoutSeconds: 2, limit: 10 });
console.log(
  `e2e: poll ok, ${page.events.length} event(s), next_cursor=${page.nextCursor}`,
);

console.log("e2e: production transport smoke passed");
console.log(
  "e2e: for a full reply proof, run: npm start -w @relaymessenger/showcase-agent",
);
console.log("e2e: then send a message to this agent in the Relay iOS app");
