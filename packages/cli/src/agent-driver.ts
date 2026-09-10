import { stat } from "node:fs/promises";
import { join } from "node:path";

import { determineAgent, type AgentResult } from "@vercel/detect-agent";
import { agentDetectedAs, type CodingAgentId } from "./coding-agents.js";
import { CLAUDE_PLUGIN_ID } from "./connect.js";

export interface DrivingAgent {
  /** The name `@vercel/detect-agent` gives it. */
  name: string;
  /** Our id for it, when it is one of the ten `connect` knows. */
  id?: CodingAgentId;
}

/**
 * The agent running this command, when one says so. The rules are Vercel's
 * package, the same twelve Supabase ported and Smithery inherits; we use the
 * package rather than copy its variables.
 */
export const drivingAgent = async (detect: () => Promise<AgentResult> = determineAgent): Promise<DrivingAgent | undefined> => {
  const result = await detect();
  if (!result.isAgent) return undefined;
  const id = agentDetectedAs(result.agent.name);
  return { name: result.agent.name, ...(id ? { id } : {}) };
};

/**
 * The machine tag Vercel's CLI (packages/cli/src/index.ts:179-184) and
 * Supabase's (login-claude-hint.ts:12) write to stderr inside Claude Code, so it
 * can offer the plugin. Ours names our plugin and marketplace.
 */
export const CLAUDE_CODE_HINT = `<claude-code-hint v="1" type="plugin" value="${CLAUDE_PLUGIN_ID}" />`;

/** Relay's documentation, written for an agent to read in one request. */
export const DOCS_LLMS_URL = "https://docs.relayapp.im/llms.txt";

export const readDocs = async (
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> => {
  try {
    const answer = await fetchImplementation(DOCS_LLMS_URL, { redirect: "follow" });
    if (!answer.ok) return undefined;
    const text = await answer.text();
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The installer names a target by agent, not by folder. `cline` is the agent
 * whose global folder is `~/.agents/skills`, the place every runtime-neutral
 * agent reads, and `claude-code` is `~/.claude/skills` (skills@1.5.25 README,
 * "Supported Agents"). Claude Code is added only when this computer has it.
 */
export const skillTargets = async (home: string, env: NodeJS.ProcessEnv): Promise<string[]> => {
  const targets = ["cline"];
  const claudeRoot = env.CLAUDE_CONFIG_DIR?.trim() ?? join(home, ".claude");
  try {
    if ((await stat(claudeRoot)).isDirectory()) targets.push("claude-code");
  } catch { /* Claude Code is not on this computer. */ }
  return targets;
};
