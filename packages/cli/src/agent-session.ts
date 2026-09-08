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
/** A new agent uses the share link Relay returned. For an older imported profile,
 * only the Relay addresses we know can be turned into a public link. */
export function savedAgentShareURL(origin: string, handle: string): string {
  const publicOrigin = origin === STAGING_API_URL ? "https://staging.relayapp.im"
    : origin === DEFAULT_API_URL ? "https://go.relayapp.im" : undefined;
  return publicOrigin ? new URL(`/@${encodeURIComponent(handle)}`, publicOrigin).href : "";
}

/** Uses the saved profile itself, never an unrelated token or address from the environment. */
export async function openSavedAgentSession(input: AgentSessionInput, dependencies: AgentSessionDependencies): Promise<TerminalSessionResult> {
  const config = await dependencies.agents.read();
  const selected = config.profiles[input.profile];
  if (!selected?.agent_token) throw new Error("This profile has no saved token, so there is nothing to watch. Sign in for this profile first.");
  const origin = validateApiURL(selected.api_url ?? DEFAULT_API_URL);
  if (input.apiURL && input.apiURL !== origin) throw new Error("The saved profile now points at a different Relay API, so the view was not opened. Sign in again for this profile.");
  const token = validateToken(selected.agent_token);
  const client = dependencies.client?.(token, origin) ?? new Relay({ apiKey: token, baseURL: origin, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
  const cards = await client.contactCard.retrieve({}, { maxRetries: 0 });
  if (cards.contact_cards.length !== 1 || cards.contact_cards[0]?.kind !== "agent" || !cards.contact_cards[0].is_active) throw new Error("This token does not belong to one active agent, so Relay cannot show its live view.");
  const card = cards.contact_cards[0];
  if (input.handle && input.handle !== card.handle) throw new Error("The saved profile now belongs to a different agent, so the view was not opened. Sign in again for this profile.");
  return (dependencies.session ?? runTerminalSession)({
    interactive: true,
    agent: { handle: card.handle, name: card.first_name, profile: input.profile, shareUrl: input.shareURL ?? savedAgentShareURL(origin, card.handle) },
    runtime: input.runtime ?? { ownership: "unknown", connection: "unknown" },
    observer: sdkTerminalObserver(client),
    secrets: [token],
  }, dependencies.io);
}
