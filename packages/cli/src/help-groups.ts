import type { Command, Help } from "commander";
import { relayHelpHeading } from "./relay-brand.js";

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

export const DOCS_URL = "https://docs.relayapp.im";
export const ISSUES_URL = "https://github.com/RelayMessenger/Relay-SDK/issues";

/**
 * The last line of every help screen: where to read more and where to report
 * a problem (GNU Coding Standards 4.8.2; gh closes with "Read the manual at
 * https://cli.github.com/manual", ledger captures/tools/gh.help.plain:68-71;
 * ledger rows P06, P07, P37). The text is the decision page's last block.
 */
export const DOCS_LINE = `Docs: ${DOCS_URL}`;
export const HELP_FOOTER = `${DOCS_LINE}\nReport a problem: ${ISSUES_URL}`;

/** clig.dev "Lead with examples"; gh, flyctl and codex do (ledger row P08). Three, from the decision page. */
export const EXAMPLES = [
  "Examples:",
  "  relaymessenger connect codex          connect Codex to Relay and wait for its first reply",
  "  relaymessenger watch                  see messages arrive and the agent reply",
  "  relaymessenger agents create --json   create an agent from a script",
];

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

export interface FlagRow {
  /** The command path, then the flags or the argument name. */
  path: string;
  description: string;
}

/** Every option and argument in the tree, hidden ones included, with its description. */
export const flagRows = (command: Command, path: readonly string[] = []): FlagRow[] => {
  const rows: FlagRow[] = [];
  const here = path.join(" ") || command.name();
  for (const option of command.options) rows.push({ path: `${here} ${option.flags}`, description: option.description });
  for (const argument of command.registeredArguments) rows.push({ path: `${here} <${argument.name()}>`, description: argument.description });
  for (const child of command.commands) rows.push(...flagRows(child, [...path, child.name()]));
  return rows;
};

/**
 * The rest of "Everything else": the names on one line. Built from the program
 * itself, so a command added later cannot fall out of the help by being
 * forgotten here.
 */
export const everythingElseNames = (program: Command): string => program.commands
  .filter((command) => command.helpGroup() === HELP_GROUPS.everythingElse)
  .map((command) => command.name())
  .join(", ");

/**
 * The help layout the decision page shows, and gh's: usage, the purpose,
 * examples, the commands, then the options (commander's default puts options
 * first). Nothing wraps: gh and stripe print each row on one line whatever the
 * terminal width, and the page's rows run past 80 columns.
 */
export const formatRelayHelp = (cmd: Command, helper: Help, heading?: string): string => {
  const root = cmd.parent === null;
  const termWidth = helper.padWidth(cmd, helper);
  const item = (term: string, description: string): string =>
    helper.formatItem(term, termWidth, description, helper);
  const lines: string[] = [];
  if (root) {
    lines.push((heading ?? relayHelpHeading()).trimEnd(), "");
    lines.push(helper.styleCommandDescription(helper.commandDescription(cmd)), "");
    const version = (cmd.version() ?? "unknown").replace(/^relaymessenger\s+/u, "");
    lines.push(helper.styleTitle("VERSION"), `  relaymessenger ${version}`, "");
    lines.push(helper.styleTitle("USAGE"), `  ${cmd.name()} [COMMAND]`, "");
  } else {
    lines.push(`${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`, "");
  }
  const description = helper.commandDescription(cmd);
  if (!root && description) lines.push(helper.styleCommandDescription(description), "");
  if (root) {
    const topicNames = ["chats", "messages", "attachments", "blocked-handles", "webhooks", "contact-card", "profiles"];
    const topics = topicNames
      .map((name) => cmd.commands.find((candidate) => candidate.name() === name))
      .filter((candidate): candidate is Command => candidate !== undefined);
    if (topics.length) {
      lines.push(helper.styleTitle("TOPICS"), ...topics.map((topic) => item(
        helper.styleSubcommandTerm(topic.name()),
        helper.styleSubcommandDescription(topic.description()),
      )), "");
    }
    const commands = helper.visibleCommands(cmd).filter((command) => command.name() !== "help");
    if (commands.length) {
      lines.push(helper.styleTitle("COMMANDS"), ...commands.map((sub) => item(
        helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
        helper.styleSubcommandDescription(helper.subcommandDescription(sub)),
      )));
      const helpCommand = cmd.commands.find((command) => command.name() === "help");
      lines.push(item(
        helper.styleSubcommandTerm(helpCommand ? helper.subcommandTerm(helpCommand) : "help [command]"),
        helper.styleSubcommandDescription(helpCommand
          ? helper.subcommandDescription(helpCommand)
          : "show what a command does and the options it takes"),
      ));
      lines.push("");
    }
  }
  const argumentRows = helper.visibleArguments(cmd)
    .map((argument) => item(helper.styleArgumentTerm(helper.argumentTerm(argument)), helper.styleArgumentDescription(helper.argumentDescription(argument))));
  if (argumentRows.length) lines.push(helper.styleTitle("Arguments:"), ...argumentRows, "");
  const commandGroups = root
    ? []
    : helper.groupItems([...cmd.commands], helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "Commands:");
  let listedCommands = false;
  for (const [group, commands] of commandGroups) {
    if (!commands.length) continue;
    lines.push(helper.styleTitle(group), ...commands.map((sub) => item(
      helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
      helper.styleSubcommandDescription(helper.subcommandDescription(sub)),
    )));
    listedCommands = true;
  }
  if (listedCommands) lines.push("");
  const optionGroups = root
    ? []
    : helper.groupItems([...cmd.options], helper.visibleOptions(cmd), (option) => option.helpGroupHeading ?? "Options:");
  for (const [group, options] of optionGroups) {
    if (!options.length) continue;
    lines.push(helper.styleTitle(group), ...options.map((option) => item(
      helper.styleOptionTerm(helper.optionTerm(option)),
      helper.styleOptionDescription(helper.optionDescription(option)),
    )), "");
  }
  // One blank line, then the footer every screen ends with (helpFooter).
  lines.push("");
  return lines.join("\n");
};

/** What follows the built-in help on every screen; the root also states the environment rule first. */
export const helpFooter = (_root: boolean): string => HELP_FOOTER;
