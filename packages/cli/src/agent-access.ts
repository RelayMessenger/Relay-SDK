import { RelayAPIError } from "@relaymessenger/sdk";
import { ConsoleRefusal } from "./console-auth.js";
import { CliError } from "./error-codes.js";

/**
 * Who may start a chat with an organization's agent, read and changed through
 * the same Relay Console routes the Console's own "Available to" field and its
 * Always Allow and Never Allow lists use (Relay-Console apps/api/src/routes/
 * agents.ts: PATCH /orgs/:orgId/agents/:id with people_can_message and
 * agents_can_message; GET, PUT and DELETE /orgs/:orgId/agents/:id/access).
 * Relay Server decides every chat (relationships.ts agentReach): people in
 * the agent's organization and its organization's agents always get through,
 * then Never Allow, then Always Allow, then the two settings. There is no
 * "private" mode: private is people off, agents nobody, plus Always Allow.
 */

/** Relay Server's values for "Other agents" (migration 0090, AGENTS_CAN_MESSAGE). */
export const AGENTS_CAN_MESSAGE = ["everyone", "communities", "nobody"] as const;
export type AgentsCanMessage = (typeof AGENTS_CAN_MESSAGE)[number];
/** `allow` is Always Allow; `deny` is Never Allow (Relay Server's AccessRule). */
export type AccessRule = "allow" | "deny";

/** The Console's request, already signed in with the saved Console session. */
export type ConsoleRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

interface ConsoleAgentRow { id: string; handle: string }
interface ConsoleAgentDetail {
  id: string;
  handle: string;
  people_can_message?: boolean;
  agents_can_message?: AgentsCanMessage;
}
/** Relay Server's contact card, as the Console forwards it. */
interface AccessCard { handle: string; display_name?: string; kind?: "user" | "agent" }
interface AccessLists { allow: AccessCard[]; deny: AccessCard[] }

/** One row of a list: who it is, and nothing the command does not use. */
export interface AccessContact { handle: string; display_name: string; kind: "user" | "agent" | null }
const contact = (card: AccessCard): AccessContact => ({
  handle: card.handle,
  display_name: card.display_name ?? card.handle,
  kind: card.kind ?? null,
});

/** The handle the way the Console's handle field reads it: no "@", trimmed, lowercase. */
export const accessHandle = (raw: string): string => raw.trim().replace(/^@/u, "").toLowerCase();

/** Relay Server's own sentences for the two refusals about the handle (contract 2001, 2032). */
const CONTACT_NOT_FOUND = "Contact was not found.";
const NOT_ON_THIS_LIST = "You can't add that contact to this list.";

/** "on" or "off", the switch "People in the Relay app" in Relay Console. */
export const peopleSwitch = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  throw new CliError("--people takes on or off.", "usage");
};

/** The organization and the agent's Console id for a handle the organization owns. */
const findAgent = async (request: ConsoleRequest, handle: string): Promise<{ path: string }> => {
  const wanted = accessHandle(handle);
  const me = await request<{ org: { id: string } }>("/me");
  const agents = await request<ConsoleAgentRow[]>(`/orgs/${encodeURIComponent(me.org.id)}/agents`);
  const agent = agents.find((entry) => entry.handle === wanted);
  if (!agent) {
    throw new CliError(`Your organization has no agent @${wanted}. Nothing was changed.`, "not_found");
  }
  return { path: `/orgs/${encodeURIComponent(me.org.id)}/agents/${encodeURIComponent(agent.id)}` };
};

const reach = (detail: ConsoleAgentDetail) => ({
  handle: detail.handle,
  // Relay Server's defaults when a row predates 0090: open, like a Discord or Telegram bot.
  people_can_message: detail.people_can_message ?? true,
  agents_can_message: detail.agents_can_message ?? "everyone",
});

/** "Available to" and both lists, the way the agent's Console page shows them. */
export async function showAccess(request: ConsoleRequest, handle: string) {
  const { path } = await findAgent(request, handle);
  const detail = await request<ConsoleAgentDetail>(path);
  const lists = await request<AccessLists>(`${path}/access`);
  return { ...reach(detail), allow: lists.allow.map(contact), deny: lists.deny.map(contact) };
}

/** Changes only the settings named; the Console reads the agent back after saving. */
export async function updateReach(
  request: ConsoleRequest,
  handle: string,
  change: { people?: boolean; agents?: AgentsCanMessage },
) {
  if (change.people === undefined && change.agents === undefined) {
    throw new CliError("Choose --people or --agents.", "usage");
  }
  if (change.agents !== undefined && !AGENTS_CAN_MESSAGE.includes(change.agents)) {
    throw new CliError("--agents takes everyone, communities or nobody.", "usage");
  }
  const { path } = await findAgent(request, handle);
  const saved = await request<ConsoleAgentDetail>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(change.people === undefined ? {} : { people_can_message: change.people }),
      ...(change.agents === undefined ? {} : { agents_can_message: change.agents }),
    }),
  });
  return reach(saved);
}

/** Relay Server's refusal about the handle, with its own code and sentence. */
const handleRefusal = (error: unknown, conflict: boolean): unknown => {
  if (error instanceof ConsoleRefusal && error.status === 404) {
    return new RelayAPIError(`${CONTACT_NOT_FOUND} Nothing was changed.`, { status: 404, code: 2001 });
  }
  if (conflict && error instanceof ConsoleRefusal && error.status === 409) {
    return new RelayAPIError(`${NOT_ON_THIS_LIST} Nothing was changed.`, { status: 409, code: 2032 });
  }
  return error;
};

/** Puts a person or agent on Always Allow (`allow`) or Never Allow (`deny`); the other list loses it. */
export async function setAccess(request: ConsoleRequest, handle: string, subject: string, rule: AccessRule) {
  const wanted = accessHandle(subject);
  if (!wanted) throw new CliError("Name the person or agent by handle.", "usage");
  const { path } = await findAgent(request, handle);
  try {
    const entry = await request<{ rule: AccessRule; contact: AccessCard }>(
      `${path}/access/${encodeURIComponent(wanted)}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rule }) },
    );
    return { ok: true as const, handle: accessHandle(handle), rule: entry.rule, contact: contact(entry.contact) };
  } catch (error) {
    throw handleRefusal(error, true);
  }
}

/** Takes a person or agent off whichever list holds it. */
export async function removeAccess(request: ConsoleRequest, handle: string, subject: string) {
  const wanted = accessHandle(subject);
  if (!wanted) throw new CliError("Name the person or agent by handle.", "usage");
  const { path } = await findAgent(request, handle);
  try {
    await request<void>(`${path}/access/${encodeURIComponent(wanted)}`, { method: "DELETE" });
  } catch (error) {
    throw handleRefusal(error, false);
  }
  return { ok: true as const, handle: accessHandle(handle), removed: wanted };
}
