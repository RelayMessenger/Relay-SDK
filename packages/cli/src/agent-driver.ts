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

export const AGENT_MODES = ["auto", "yes", "no"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * Supabase's global flag, verbatim (`--agent <[ auto | yes | no ]>  Override
 * agent detection: yes, no, or auto (default auto)`, ledger captures/tools/
 * supabase.help.plain:23; row P53). Read before commander parses, because the
 * answer decides whether there is a menu to parse into. `auto` is the package's
 * verdict; `yes` is an agent even when nothing says so; `no` is a person even
 * inside one. An unknown value is left to commander, whose choices refuse it.
 */
export const agentMode = (argv: readonly string[]): AgentMode => {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = arg === "--agent" ? argv[index + 1] : arg.startsWith("--agent=") ? arg.slice(8) : undefined;
    if (value !== undefined && (AGENT_MODES as readonly string[]).includes(value)) return value as AgentMode;
  }
  return "auto";
};

/** The agent driving this command once the override has spoken. */
export const resolveDrivingAgent = async (
  mode: AgentMode,
  detect?: () => Promise<AgentResult>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DrivingAgent | undefined> => {
  if (mode === "no") return undefined;
  const detected = await drivingAgent(detect);
  if (mode === "yes") return detected ?? { name: "agent" };
  // @vercel/detect-agent 1.2.5 reads AI_AGENT and CODEX_SANDBOX but not CI.
  // Decision page rows 8/17 also require CI, including injected environments.
  return detected ?? (env.AI_AGENT?.trim() ? { name: env.AI_AGENT.trim(), ...(agentDetectedAs(env.AI_AGENT.trim()) ? { id: agentDetectedAs(env.AI_AGENT.trim())! } : {}) }
    : env.CODEX_SANDBOX ? { name: "codex", id: "codex" }
    : env.CI && !["0", "false"].includes(env.CI.toLowerCase()) ? { name: "CI" } : undefined);
};

/**
 * Said once per run, to stderr, when an agent is driving: Vercel's skills line
 * (`●   claude  Agent detected — installing non-interactively`, ledger README
 * P51) with the docs an agent can read in one request under it, Railway's
 * headless shape (row 17 of the decision page).
 */
export const agentDetectedLines = (agent: DrivingAgent): string =>
  `●  ${agent.id ?? agent.name}  Agent detected — running non-interactively\nDocs: ${DOCS_LLMS_URL}\n`;

/**
 * The machine tag Vercel's CLI (packages/cli/src/index.ts:179-184) and
 * Supabase's (login-claude-hint.ts:12) write to stderr inside Claude Code, so it
 * can offer the plugin. Ours names our plugin and marketplace.
 */
export const CLAUDE_CODE_HINT = `<claude-code-hint v="1" type="plugin" value="${CLAUDE_PLUGIN_ID}" />`;

/** Relay's documentation, written for an agent to read in one request. */
export const DOCS_LLMS_URL = "https://docs.relayapp.im/llms.txt";

/**
 * llms.txt is one H1 and a list of H2 sections (llmstxt.org). `docs --list`
 * names the sections and `docs <section>` prints one, so an agent can take the
 * part it needs instead of 32,825 bytes (Anthropic, "Writing tools for agents":
 * pagination or range selection for any response that could fill the context;
 * ledger rows P45 and P47). Bare `docs` still prints the whole file.
 */
export const docsSections = (text: string): string[] =>
  text.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());

const sectionKey = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

/** The named section, heading included, up to the next H2; undefined when there is no such section. */
export const docsSection = (text: string, name: string): string | undefined => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && sectionKey(line.slice(3)) === sectionKey(name));
  if (start === -1) return undefined;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return `${lines.slice(start, end).join("\n").trimEnd()}\n`;
};

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
