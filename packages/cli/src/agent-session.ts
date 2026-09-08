import Relay from "@relaymessenger/sdk";
import type { AgentDependencies } from "./agents.js";
import { DEFAULT_API_URL, STAGING_API_URL, validateApiURL, validateToken } from "./config.js";
import { runTerminalSession, type TerminalSessionIO, type TerminalSessionOptions, type TerminalSessionResult, type TerminalRuntimeState } from "./terminal-session.js";
import { sdkTerminalObserver } from "./terminal-watch.js";

export interface AgentSessionInput {
  profile: string;
  handle?: string;
  apiURL?: string;
  shareURL?: string;
  runtime?: TerminalRuntimeState;
}
export interface AgentSessionDependencies {
  agents: Pick<AgentDependencies, "read">;
  fetch?: typeof globalThis.fetch;
  session?: (options: TerminalSessionOptions, io?: TerminalSessionIO) => Promise<TerminalSessionResult>;
  io?: TerminalSessionIO;
  client?: (token: string, origin: string) => Pick<Relay, "contactCard" | "websocket">;
}
/** New identities use the exact server share URL. For older imported profiles,
 * only known Relay environments have a source-backed public-link mapping. */
export function savedAgentShareURL(origin: string, handle: string): string {
  const publicOrigin = origin === STAGING_API_URL ? "https://staging.relayapp.im"
    : origin === DEFAULT_API_URL ? "https://go.relayapp.im" : undefined;
  return publicOrigin ? new URL(`/@${encodeURIComponent(handle)}`, publicOrigin).href : "";
}

/** Uses the actual saved profile, never an unrelated ENV token or origin. */
export async function openSavedAgentSession(input: AgentSessionInput, dependencies: AgentSessionDependencies): Promise<TerminalSessionResult> {
  const config = await dependencies.agents.read();
  const selected = config.profiles[input.profile];
  if (!selected?.agent_token) throw new Error("Selected profile has no saved credential for viewing.");
  const origin = validateApiURL(selected.api_url ?? DEFAULT_API_URL);
  if (input.apiURL && input.apiURL !== origin) throw new Error("Selected profile origin changed; no observer opened.");
  const token = validateToken(selected.agent_token);
  const client = dependencies.client?.(token, origin) ?? new Relay({ apiKey: token, baseURL: origin, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
  const cards = await client.contactCard.retrieve({}, { maxRetries: 0 });
  if (cards.contact_cards.length !== 1 || cards.contact_cards[0]?.kind !== "agent" || !cards.contact_cards[0].is_active) throw new Error("An active saved agent is required for the terminal view.");
  const card = cards.contact_cards[0];
  if (input.handle && input.handle !== card.handle) throw new Error("Selected profile identity changed; no observer opened.");
  return (dependencies.session ?? runTerminalSession)({
    interactive: true,
    agent: { handle: card.handle, name: card.first_name, profile: input.profile, shareUrl: input.shareURL ?? savedAgentShareURL(origin, card.handle) },
    runtime: input.runtime ?? { ownership: "unknown", connection: "unknown" },
    observer: sdkTerminalObserver(client),
    secrets: [token],
  }, dependencies.io);
}
