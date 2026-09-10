import type { Command } from "commander";

/**
 * Three groups, the way gh and fly group theirs: the one thing a new person
 * runs, the few things they run afterwards, and everything else behind one
 * line. A person meeting Relay should read three rows, not sixty-three.
 */
export const HELP_GROUPS = {
  getStarted: "Get started:",
  everyDay: "Every day:",
  everythingElse: "Everything else:",
  /** Reachable, described, and named nowhere in the help: an older name kept
   * working for the scripts that already use it. */
  unlisted: "",
} as const;

export interface CommandRow {
  /** Space-separated path, for example `chats messages send`. */
  path: string;
  description: string;
}

/** Every command under this one, at any depth, with the description it shows. */
export const commandRows = (command: Command, path: readonly string[] = []): CommandRow[] => {
  const rows: CommandRow[] = [];
  for (const child of command.commands) {
    const here = [...path, child.name()];
    rows.push({ path: here.join(" "), description: child.description() });
    rows.push(...commandRows(child, here));
  }
  return rows;
};

/**
 * The rest of "Everything else": the names on one line, then where to read about
 * any of them. Built from the program itself, so a command added later cannot
 * fall out of the help by being forgotten here. The heading is commander's own,
 * printed just above this by the one command in the group that is not hidden.
 */
export const everythingElseHelp = (program: Command): string => {
  const names = program.commands
    .filter((command) => command.helpGroup() === HELP_GROUPS.everythingElse)
    .map((command) => command.name());
  if (!names.length) return "";
  return `  ${names.join(", ")}\n  run  relaymessenger help <command>  for any of these\n`;
};
