import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
} from "commander";
import {
  CLAUDE_CODE_HINT,
  agentDetectedLines,
  agentMode,
  resolveDrivingAgent,
  skillTargets,
} from "./agent-driver.js";
import { agentDependencies } from "./agents.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerAgentsCommands } from "./commands/agents.js";
import { registerChatsCommands } from "./commands/chats.js";
import { registerConnectCommands } from "./commands/connect.js";
import {
  agentModeValue,
  createCommandContext,
  type ProgramDependencies,
} from "./commands/context.js";
import { registerMessagesCommands } from "./commands/messages.js";
import { registerWebhooksAndContactCardCommands } from "./commands/webhooks.js";
import {
  collectConfiguredTokens,
  configPath,
  type ConfigContext,
} from "./config.js";
import { CliError } from "./error-codes.js";
import { describeFailure } from "./errors.js";
import { EXIT_CODES, exitCodesHelp } from "./exit-codes.js";
import {
  HELP_GROUPS,
  docsLine,
  formatRelayHelp,
  helpFooter,
} from "./help-groups.js";
import {
  HeadlessPrompt,
  InteractiveCancelled,
  chooseInteractiveCommand,
  clackPrompts,
  interactiveAllowed,
  interactiveEntry,
} from "./interactive.js";
import { errorText, jsonText } from "./output.js";
import { relayHelpHeading, writeRelayHelpHeading } from "./relay-brand.js";
import {
  installRelaySkill,
  relaySkillGlobalArgs,
  relaySkillPresent,
} from "./skill-offer.js";
import {
  isOutdated,
  staleRouteStatus,
  startUpdateCheck,
  updateNotice,
  type UpdateCheck,
} from "./update-check.js";
import { verboseFetch } from "./verbose.js";

export type { ProgramDependencies } from "./commands/context.js";

// The shipped version is the manifest's; the release job derives it, so no
// source file may carry its own copy.
const PACKAGE_VERSION: string = createRequire(import.meta.url)("../package.json").version;

export const createProgram = (
  dependencies: ProgramDependencies = {},
): Command => {
  const ctx = createCommandContext(dependencies);
  const { stdout, stderr, configContext, usageError } = ctx;

  // The option rows are the decision page's, in its order. `--version` names
  // the program; `--no-input` and `--non-interactive` share one option row;
  // `--agent` overrides runtime detection; `-q` and `--verbose` follow clig.dev.
  const program = new Command()
    .name("relaymessenger")
    .helpOption("-h, --help", "help")
    .description("Message the agent on your computer from your phone")
    .version(`relaymessenger ${PACKAGE_VERSION}`, "-V, --version", "the version")
    .option("--json", "JSON output")
    .option("--no-input, --non-interactive", "no prompts")
    .option("--agent <auto|yes|no>", "runtime detection override (default auto)", agentModeValue)
    .option("-q, --quiet", "errors only")
    .option("--verbose", "request method, path, status, milliseconds on stderr")
    .option("--profile <name>", "the saved profile to use", (configContext.env ?? process.env).RELAY_PROFILE)
    .option("--install-skills", "Relay skill installation for local runtimes");
  program.exitOverride();
  program.configureOutput({
    writeOut: stdout,
    writeErr: stderr,
    outputError: usageError,
  });
  // gh's order: commands before flags, examples first, no wrapping (help-groups.ts).
  program.configureHelp({
    formatHelp: (command, helper) => formatRelayHelp(command, helper, dependencies.helpHeading),
    minWidthToWrap: Number.POSITIVE_INFINITY,
  });
  // Every help screen ends the same way (GNU 4.8.2; gh's LEARN MORE block).
  program.addHelpText("afterAll", (context) => helpFooter(context.command === program, configContext.env ?? process.env));

  registerConnectCommands(program, ctx);
  registerAgentsCommands(program, ctx);
  registerAccountCommands(program, ctx);
  registerChatsCommands(program, ctx);
  registerMessagesCommands(program, ctx);
  registerWebhooksAndContactCardCommands(program, ctx);

  // gh's `gh help exit-codes`: a help topic, reachable as `help exit-codes`,
  // `exit-codes` and `exit-codes --help`, each printing the same table and
  // nothing else. Named nowhere in the listings.
  program
    .command("exit-codes", { hidden: true })
    .description("show exit codes and their meanings")
    .helpGroup(HELP_GROUPS.unlisted)
    .configureHelp({ formatHelp: () => `${exitCodesHelp()}\n` })
    .action(() => stdout(exitCodesHelp()));

  // Last, so only the root's own help command takes this group: set earlier, the
  // default would be inherited by every subcommand and put an "Everything else"
  // heading on ten help screens that have no such section.
  program.commandsGroup(HELP_GROUPS.everythingElse).helpCommand(false);
  program.command("help")
    .argument("[command]", "command to show help for")
    .description("show what a command does")
    .action((name?: string) => {
      const target = name === undefined ? program : program.commands.find(
        (command) => command.name() === name || command.aliases().includes(name),
      );
      if (!target) {
        program.showHelpAfterError(!dependencies.json);
        return program.error(`error: unknown command '${name}'`, { code: "commander.unknownCommand", exitCode: 2 });
      }
      target.help();
    });

  return program;
};

const defaultUpdateCheck = (env: NodeJS.ProcessEnv, context: ConfigContext | undefined): UpdateCheck | undefined => {
  // Test runs and CI never reach the registry (update-notifier skips CI too).
  if (process.env.RELAY_NO_UPDATE_CHECK || process.env.VITEST || env.CI || process.env.CI) return undefined;
  let cacheFile: string;
  try { cacheFile = join(dirname(configPath(context)), "update-check.json"); } catch { return undefined; }
  return startUpdateCheck({ version: PACKAGE_VERSION, cacheFile, env });
};

export const runCLI = async (
  argv: string[],
  dependencies: ProgramDependencies = {},
): Promise<number> => {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const env = dependencies.configContext?.env ?? process.env;
  const json = argv.includes("--json");
  const helpRequested = argv.length === 0
    || argv.includes("--help")
    || argv.includes("-h")
    || argv[0] === "help";
  // `-q` keeps stderr for errors alone: the agent line, the plugin hint, the
  // cancel note and the skill offer all stay silent (clig.dev, standard names).
  const quiet = argv.includes("-q") || argv.includes("--quiet");
  const note = quiet ? (): void => undefined : stderr;
  // npm's update-notifier shape (gh and vercel too): a cached daily read of
  // the dist-tag, never blocking or failing the command, one notice on stderr.
  const updateCheck = dependencies.updateCheck === false ? undefined
    : dependencies.updateCheck ?? defaultUpdateCheck(env, dependencies.configContext);
  const outdatedLatest = async (): Promise<string | undefined> => {
    const latest = await updateCheck?.latest;
    return updateCheck && latest && isOutdated(updateCheck.version, latest) ? latest : undefined;
  };
  const noticeIfOutdated = async (): Promise<void> => {
    if (json || quiet || !updateCheck) return;
    const latest = await outdatedLatest();
    if (latest) stderr(updateNotice(updateCheck, latest, argv, dependencies.fromNpx));
  };
  if (argv.includes("--verbose")) {
    dependencies = { ...dependencies, fetch: verboseFetch(dependencies.fetch ?? globalThis.fetch, stderr) };
  }
  const driver = await resolveDrivingAgent(agentMode(argv), dependencies.detectAgent ?? (dependencies.configContext?.env ? async () => ({ isAgent: false, agent: undefined }) : undefined), env);
  const interactive = interactiveAllowed(argv, dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY))
    && driver === undefined && !quiet;
  if (driver) {
    if (!helpRequested && driver.id === "claude-code" && !json) note(`${CLAUDE_CODE_HINT}\n`);
    if (!helpRequested) note(agentDetectedLines(driver));
  }
  if (driver?.id) dependencies = { ...dependencies, connect: { ...dependencies.connect, drivingAgent: driver.id } };
  const ui = interactive ? dependencies.prompts ?? clackPrompts((message) => note(`${message}\n`)) : undefined;
  const agentDeps = dependencies.agents ?? agentDependencies(dependencies.configContext, dependencies.fetch);
  let offered = false;
  const skillOffer = async (force = false): Promise<number> => {
    if (!ui || offered) return 0;
    offered = true;
    const inform = (message: string) => { try { ui.info(message); } catch { /* Optional output cannot invalidate the command. */ } };
    try {
      const cwd = dependencies.cwd ?? process.cwd();
      if (!force) {
        const present = await (dependencies.skillPresent ?? (() => relaySkillPresent(cwd, dependencies.configContext?.home ?? homedir(), env)))();
        if (present !== false) return 0;
      }
      if (!await ui.confirm("Install the Relay skill? The installer will ask which runtimes to install it for, and whether to install it for this folder or for you everywhere.")) return 0;
      try {
        await (dependencies.skillInstaller ?? (() => installRelaySkill(cwd, env)))();
        inform("The Relay skill is installed.");
        return 0;
      } catch {
        inform("The Relay skill was not installed. Your agent and your saved token are unchanged.");
        return force ? 1 : 0;
      }
    } catch (error) {
      inform("Skipped installing the Relay skill. Your agent and your saved token are unchanged.");
      if (error instanceof InteractiveCancelled && !force) throw error;
      return error instanceof InteractiveCancelled ? 0 : force ? 1 : 0;
    }
  };
  try {
    let args = argv;
    if (argv.includes("--install-skills")) {
      const home = dependencies.configContext?.home ?? homedir();
      const cwd = dependencies.cwd ?? process.cwd();
      const targets = await skillTargets(home, env);
      try {
        // Off a terminal, or with stdout promised to --json, the installer
        // paints nothing and speaks on stderr (skill-offer.ts).
        await (dependencies.skillInstaller ?? (() => installRelaySkill(cwd, env, relaySkillGlobalArgs(targets), !interactive)))();
      } catch {
        throw new CliError("The Relay skill was not installed. Nothing else was changed.", "refused");
      }
      args = argv.filter((arg) => arg !== "--install-skills");
      if (!args.length) return EXIT_CODES.ok;
    }
    const entry = interactiveEntry(args);
    if (ui && entry && entry.entry !== "root") {
      const selected = await chooseInteractiveCommand(entry.entry, entry.prefix, agentDeps, ui);
      if (!selected) return EXIT_CODES.ok;
      if (selected === "install-skill") return await skillOffer(true);
      args = selected;
    } else if (entry) args = [...args, "--help"];
    const rootHelpRequested = args.length === 0
      || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!));
    let helpHeading: string | undefined;
    if (rootHelpRequested && !json && !quiet) {
      const helpTTY = dependencies.helpTTY
        ?? Boolean(process.stdout.isTTY && process.stderr.isTTY);
      if (helpTTY) {
        await writeRelayHelpHeading(
          stdout,
          true,
        );
        helpHeading = "";
      } else {
        helpHeading = relayHelpHeading();
      }
    }
    await createProgram({
      ...dependencies, isInteractive: interactive, json, stderr,
      // A caller that captures stdout (a test, an embedding) reads JSON unless it asks.
      humanOutput: !json && !quiet && driver === undefined
        && (dependencies.humanOutput ?? (dependencies.stdout === undefined && Boolean(process.stdout.isTTY))),
      ...(helpHeading !== undefined ? { helpHeading } : {}),
      ...(quiet ? { stdout: () => undefined } : {}),
      ...(ui ? {
        prompts: ui,
        offerSkill: async () => { await skillOffer(); },
        readSecret: dependencies.readSecret ?? (() => ui.password("Paste your token")),
        confirmDelete: () => ui.confirm("Delete the selected agent? This cannot be undone."),
        confirmLogout: () => ui.confirm("Remove the saved token from this computer? The agent itself is not deleted."),
      } : {}),
    }).parseAsync(args, { from: "user" });
    await noticeIfOutdated();
    return EXIT_CODES.ok;
  } catch (caught) {
    let error = caught;
    if (error instanceof InteractiveCancelled) { note("Cancelled.\n"); return EXIT_CODES.ok; }
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version", "commander.help"].includes(error.code)) {
      await noticeIfOutdated();
      return error.exitCode;
    }
    // A route this copy calls that Relay no longer has (404 or 410) is the
    // old-version dead end: say so, with the command that fixes it.
    const latest = staleRouteStatus(error) ? await outdatedLatest() : undefined;
    if (updateCheck && latest) {
      const text = error instanceof Error ? error.message : String(error);
      error = new CliError(`${text} This relaymessenger is ${updateCheck.version}, and Relay no longer answers some requests from old versions. The newest is ${latest}.\n${updateNotice(updateCheck, latest, argv, dependencies.fromNpx).split("\n").slice(1).join("\n").trimEnd()}`, "outdated");
    } else {
      await noticeIfOutdated();
    }
    let secrets: string[] = [];
    try {
      secrets = await collectConfiguredTokens(dependencies.configContext);
    } catch {
      if (env.RELAY_AGENT_TOKEN) secrets = [env.RELAY_AGENT_TOKEN];
    }
    // One envelope for every failure, usage errors included, and one exit code
    // per class (exit-codes.ts). The text form keeps commander's own sentence
    // for a usage error (already written, with the Docs line) and Stripe's and
    // eas's shape for a question with no terminal: the flags, never a usage block.
    const failure = describeFailure(error, secrets);
    if (json) {
      stderr(jsonText({ error: failure.error, code: failure.code, next_step: failure.next_step }));
      return failure.exit;
    }
    if (error instanceof CommanderError) {
      // Parser errors were printed by configureOutput; a raw coercion error
      // thrown inside an action has not passed through that reporter.
      const alreadyReported = !(error instanceof InvalidArgumentError) && [
        "commander.unknownOption", "commander.unknownCommand", "commander.missingArgument",
        "commander.optionMissingArgument", "commander.missingMandatoryOptionValue",
        "commander.excessArguments", "commander.invalidArgument",
      ].includes(error.code);
      if (error.message && !alreadyReported) stderr(`Error: ${failure.error}\n${docsLine(env)}\n`);
      return failure.exit;
    }
    if (error instanceof HeadlessPrompt) {
      const message = errorText(error, secrets);
      stderr(error.flags.length
        ? `Error: ${message}\nThere is no terminal here, so nothing was asked. Pass one of these instead:\n${error.flags.map((flag) => `  ${flag}`).join("\n")}\n`
        : `Error: ${message} ${error.nextStep}\n`);
      return failure.exit;
    }
    stderr(`Error: ${failure.error}\n`);
    return failure.exit;
  }
};
