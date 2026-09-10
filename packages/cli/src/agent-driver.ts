import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The coding agents that announce themselves in the environment, and the exact
 * variable each one sets. Measured on 2026-09-09: with `CLAUDECODE=1` Vercel's
 * CLI prints `isAgent=true agentName=claude … => nonInteractive=true`, and its
 * own bundled detector carries the strings `CODEX_HOME`, `CURSOR` and
 * `CURSOR_CLI` (Relay-Research/research/cli-hands-on-20260909/vercel.md, section
 * 12). `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are also the homes the pinned skills
 * installer reads, so Relay already trusts them to mean those agents.
 */
export const AGENT_VARIABLES: ReadonlyArray<{ variable: string; name: string }> = [
  { variable: "CLAUDECODE", name: "Claude Code" },
  { variable: "CURSOR_CLI", name: "Cursor" },
  { variable: "CURSOR", name: "Cursor" },
  { variable: "CODEX_HOME", name: "Codex" },
];

export interface DrivingAgent {
  name: string;
  variable: string;
}

/** The agent running this command, when one says so. */
export const drivingAgent = (env: NodeJS.ProcessEnv): DrivingAgent | undefined => {
  for (const entry of AGENT_VARIABLES) {
    const value = env[entry.variable]?.trim();
    if (value) return { name: entry.name, variable: entry.variable };
  }
  return undefined;
};

/** One line, so the agent reading it knows why it saw no menu. */
export const drivingAgentHint = (agent: DrivingAgent): string =>
  `Relay sees ${agent.name} (${agent.variable}), so it asks nothing. Every question has a flag: run  relaymessenger connect --help.`;

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
