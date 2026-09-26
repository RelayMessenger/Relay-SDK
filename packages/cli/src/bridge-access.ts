/**
 * What a connected agent may do on this computer.
 *
 * A Relay agent connected with `relay connect` runs on its owner's computer,
 * and any Relay agent from any owner can message it (the staging probe of
 * 2026-09-26, `_sources/unattended-agent-permissions-20260926/
 * relay-staging-probe-20260926.txt`). So by default every bridge runs its
 * agent in the maker's own mode for a turn nobody is watching: it reads, and
 * runs no commands. `--dangerously-skip-permissions` turns each maker's
 * permission checks off, as Claude Code's flag of the same name does.
 */
export interface BridgeAccess {
  /** Each maker's own permission-skipping mode, chosen with `--dangerously-skip-permissions`. */
  fullAccess: boolean;
}

/** The flag that turns every maker's permission checks off, named after Claude Code's own. */
export const FULL_ACCESS_FLAG = "--dangerously-skip-permissions";

/**
 * Pi's "Read-only mode": `pi --tools read,grep,find,ls`
 * (@earendil-works/pi-coding-agent README, CLI examples). Pi has no permission
 * prompts of its own ("No permission popups. Run in a container, or build your
 * own confirmation flow"), so the tool list is its one documented gate.
 * `--dangerously-skip-permissions` gives pi its default tools back.
 */
export const PI_READ_ONLY_TOOLS = ["--tools", "read,grep,find,ls"] as const;

/** What the pi channel takes for one connect run: pi's tools. */
export const piAccess = (access: BridgeAccess): { piArgs: readonly string[] } => ({
  piArgs: access.fullAccess ? [] : PI_READ_ONLY_TOOLS,
});

/**
 * The plan's one line for a bridge: that it answers from this folder, and what
 * it may do, so the person reads the choice before anything starts. `notes`
 * are the runtime's own remarks, kept inside the one parenthesis.
 */
export const bridgeLine = (label: string, fullAccess: boolean, notes: readonly string[] = []): string => {
  const rights = fullAccess
    ? { says: "it runs every tool with no permission checks", note: `${FULL_ACCESS_FLAG}: recommended only for sandboxes with no internet access` }
    : { says: "it runs no commands", note: `${FULL_ACCESS_FLAG} turns every permission check off` };
  return `keep running here, and answer your Relay messages with ${label} from this folder; ${rights.says}  (${[...notes, rights.note].join("; ")})`;
};
