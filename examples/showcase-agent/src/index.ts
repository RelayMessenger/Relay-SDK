import { homedir } from "node:os";
import { join } from "node:path";
import {
  createFileCursorStore,
  createRelayClient,
  isVisibleMessage,
  MemoryDedupe,
  runPollLoop,
} from "@relaymessenger/sdk";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example and set your Agent Token.`);
    process.exit(1);
  }
  return value;
}

const token = requireEnv("RELAY_AGENT_TOKEN");
const baseUrl = process.env.RELAY_API_URL?.trim();
const stateDir =
  process.env.RELAY_STATE_DIR?.trim() ||
  join(homedir(), ".relay", "showcase-agent");

const client = createRelayClient({
  token,
  ...(baseUrl ? { baseUrl } : {}),
});
const cursorStore = createFileCursorStore(join(stateDir, "cursor.json"));
const dedupe = new MemoryDedupe();
const abort = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => abort.abort());
}

const me = await client.getMe();
cursorStore.load();

console.log(
  `[showcase] connected as @${me.handle} (${me.id}); long-polling from cursor ${cursorStore.current()}`,
);
console.log("[showcase] message this agent in the Relay app to get an echo reply");

await runPollLoop({
  client,
  getCursor: () => cursorStore.current(),
  setCursor: (cursor) => cursorStore.advance(cursor),
  dedupe,
  abortSignal: abort.signal,
  log: (line) => console.log(line),
  allowSender: (senderId) => {
    if (!me.owner_user_id) return true;
    return senderId === me.owner_user_id;
  },
  onMessage: async ({ message, reply, responding, typing }) => {
    // A replayed event can carry a tombstone for a message that has since been
    // unsent, and a tombstone has no parts and no fallback text.
    if (!isVisibleMessage(message)) {
      console.log(`[showcase] <- ${message.id}: (unsent)`);
      return;
    }
    const text =
      message.parts.find((part) => part.type === "text")?.text?.trim() ||
      message.fallback_text ||
      "(no text)";
    console.log(`[showcase] <- ${message.id}: ${text}`);
    try {
      await responding("Thinking…");
      const result = await reply.text(`Echo from @${me.handle}: ${text}`);
      console.log(`[showcase] -> ${result.messages.map((sent) => sent.id).join(", ")}`);
    } finally {
      await typing(false);
    }
  },
});

console.log("[showcase] stopped");
