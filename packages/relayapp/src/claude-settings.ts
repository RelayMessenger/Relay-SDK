/**
 * Best-effort read of the Claude Code permission mode that
 * @agentclientprotocol/claude-agent-acp inherits. When the resolved
 * permissions.defaultMode is bypassPermissions, the engine never sends
 * session/request_permission, so Relay's phone Allow/Deny cards silently
 * disappear. Missing or unreadable settings files are ignored (silent).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedDefaultMode {
  mode: string;
  /** Settings file the winning value came from. */
  source: string;
}

function readDefaultMode(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const mode = parsed?.permissions?.defaultMode;
    return typeof mode === "string" ? mode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve permissions.defaultMode the way Claude Code does, highest
 * precedence first: project .claude/settings.local.json, then project
 * .claude/settings.json, then user ~/.claude/settings.json.
 */
export function resolveClaudeDefaultMode(
  projectDir: string = process.cwd(),
  home: string = homedir(),
): ResolvedDefaultMode | undefined {
  const candidates = [
    join(projectDir, ".claude", "settings.local.json"),
    join(projectDir, ".claude", "settings.json"),
    join(home, ".claude", "settings.json"),
  ];
  for (const path of candidates) {
    const mode = readDefaultMode(path);
    if (mode !== undefined) return { mode, source: path };
  }
  return undefined;
}

/** One-line warning when phone approvals cannot fire, else undefined. */
export function claudeBypassWarning(
  projectDir?: string,
  home?: string,
): string | undefined {
  const resolved = resolveClaudeDefaultMode(projectDir, home);
  if (resolved?.mode !== "bypassPermissions") return undefined;
  return (
    `Claude permissions.defaultMode=bypassPermissions (${resolved.source}) — ` +
    "the engine never asks for approval, so Relay's phone Allow/Deny cards will not appear"
  );
}
