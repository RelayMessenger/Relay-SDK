import { startHermesRelayChannel } from "./index.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}

const token = requireEnv("RELAY_AGENT_TOKEN");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => abort.abort());
}

await startHermesRelayChannel({
  token,
  ...(process.env.RELAY_API_URL ? { baseUrl: process.env.RELAY_API_URL } : {}),
  abortSignal: abort.signal,
  handleTurn: async ({ message }) => {
    const text =
      message.parts.find((part) => part.type === "text")?.text?.trim() ||
      message.fallback_text ||
      "";
    // Default demo turn: echo. Wire Hermes' agent runtime here.
    return text ? `Hermes↔Relay: ${text}` : null;
  },
});
