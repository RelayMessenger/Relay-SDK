import { homedir } from "node:os";
import { runPiChannel } from "@relaymessenger/pi";
import Relay from "@relaymessenger/sdk";
import { Command, Option } from "commander";
import { acpCommand, runAcpBridge } from "../acp-bridge.js";
import { openAcpSessions } from "../acp-threads.js";
import { openSavedAgentSession } from "../agent-session.js";
import { selectAgentAuth } from "../agents.js";
import { OwnerApprovals, piApprovals } from "../approvals.js";
import { claudeCommand, runClaudeBridge } from "../claude-bridge.js";
import { openClaudeThreads } from "../claude-threads.js";
import { codexCommand, runCodexBridge } from "../codex-bridge.js";
import { openCodexThreads } from "../codex-threads.js";
import { supportedAgentsLine } from "../coding-agents.js";
import { defaultCreationApiURL, resolveAuth, validateApiURL } from "../config.js";
import { runConnect, type ConnectOptions as ConnectRunOptions } from "../connect.js";
import { consoleLoginOrReuse } from "../console-auth.js";
import { runDoctor } from "../doctor.js";
import { CliError } from "../error-codes.js";
import { HELP_GROUPS } from "../help-groups.js";
import { sdkTerminalObserver, terminalEventLine } from "../terminal-watch.js";
import {
  descriptionText,
  globals,
  handle,
  subtitleText,
  type CommandContext,
} from "./context.js";

export const registerConnectCommands = (program: Command, ctx: CommandContext): void => {
  const {
    dependencies,
    stdout,
    stderr,
    configContext,
    resolveClient,
    output,
    agentDeps,
    readStdinText,
    willShowSavedAgent,
    forwardEvents,
  } = ctx;

  // Docker MCP's shape (cmd/docker-mcp/commands/client.go:56-59): the supported
  // list sits inside the usage line, built from the registry so it cannot drift.
  program
    .command("connect")
    .usage(`[options] [agent]\n${supportedAgentsLine()}`)
    .argument("[agent]", "the runtime to connect")
    .description("connect a coding agent and wait for a reply")
    .helpGroup(HELP_GROUPS.getStarted)
    .option("--new", "a new agent")
    .option("--handle <handle>", "the agent's handle")
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .option("--image <path-or-url>", "a picture file or https:// address")
    .option("--avatar <file>", "a local PNG or JPEG picture")
    // gh's `auth login --with-token` (ledger row P25): the token comes down a
    // pipe and never touches `ps` or the shell history. `--token` stays for
    // scripts and is the visible one.
    .option("--with-token", "an existing token from a pipe")
    .option("--token <token>", "an existing token, visible in shell history")
    .option("--allow <handles>", "allowed sender handles, comma-separated; default everyone")
    .option("-y, --yes", "token replacement without asking")
    .option("--dry-run", "the plan, nothing changed")
    .option("--no-start", "no start offer")
    .option("--no-skill", "no Relay skill offer")
    .option("--json", "JSON output")
    .addOption(new Option("--api-url <url>", "the Relay API address to use").argParser(validateApiURL).hideHelp())
    .action(async (agent: string | undefined, options: ConnectRunOptions & { withToken?: boolean }, command: Command) => {
      const env = configContext.env ?? process.env;
      const home = configContext.home ?? homedir();
      const { withToken, ...rest } = options;
      let token = rest.token;
      if (withToken) {
        if (token !== undefined) throw new CliError("Choose --with-token or --token, not both.", "usage");
        token = (await readStdinText()).trim();
        if (!token) throw new CliError("Nothing was piped in. Pipe the token into this command, for example: echo \"$RELAY_AGENT_TOKEN\" | npx relaymessenger connect codex --with-token", "usage");
      }
      await runConnect(agent, {
        ...rest, ...(token === undefined ? {} : { token }),
        json: options.json === true || globals(command).json === true,
        nonInteractive: globals(command).nonInteractive === true || program.getOptionValue("input") === false,
      }, {
        agents: agentDeps,
        env,
        home,
        cwd: dependencies.cwd ?? process.cwd(),
        ...(configContext.platform ? { platform: configContext.platform } : {}),
        ...(globals(command).profile ? { profile: globals(command).profile } : {}),
        stdout,
        stderr,
        ...(dependencies.prompts && dependencies.isInteractive !== false ? { prompts: dependencies.prompts } : {}),
        // Pairing watches the agent's own events; it never answers Relay and
        // never takes an event, so the runtime still receives every message.
        observer: (observerToken, apiURL) => sdkTerminalObserver(new Relay({ apiKey: observerToken, baseURL: apiURL, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) })),
        // Codex, Cursor, Gemini CLI, OpenCode and Pi cannot start a turn of their
        // own, so connect stays and answers for them: Codex over its app-server
        // (codex-bridge.ts), the others over ACP (acp-bridge.ts). Control-C ends
        // the wait and the command.
        bridge: async (input) => {
          const control = new AbortController();
          const stop = (): void => control.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          const relayClient = () => new Relay({ apiKey: input.token, baseURL: input.apiURL, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
          // What the coding agent would ask at its own terminal goes to the
          // agent's owners in Relay, as a card; only an owner's tap answers.
          const approvals = new OwnerApprovals({ client: relayClient(), say: input.say });
          try {
            if (input.kind === "pi") {
              await runPiChannel({
                agentToken: input.token,
                baseURL: input.apiURL,
                piCommand: input.command,
                relay: relayClient(),
                approvals: piApprovals(approvals),
              }, control.signal);
            } else if (input.kind === "claude") {
              await runClaudeBridge({
                client: relayClient(),
                media: { token: input.token, apiURL: input.apiURL, context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
                claude: await claudeCommand(input.command, env),
                cwd: input.cwd,
                threads: await openClaudeThreads({ apiURL: input.apiURL, handle: input.handle }, configContext),
                mcp: { url: input.mcpURL, token: input.token },
                approvals,
                signal: control.signal,
                say: input.say,
              });
            } else if (input.kind === "acp") {
              await runAcpBridge({
                client: relayClient(),
                media: { token: input.token, apiURL: input.apiURL, context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
                acp: await acpCommand(input.command, input.acpArgs ?? [], env),
                cwd: input.cwd,
                // Relay's own tools travel through the agent's session.
                mcp: { url: input.mcpURL, token: input.token },
                label: input.label,
                approvals,
                // The chat's ACP session outlives this run, so a restart picks
                // every chat up where it stopped (acp-threads.ts).
                sessions: await openAcpSessions({ apiURL: input.apiURL, handle: input.handle }, configContext),
                signal: control.signal,
                say: input.say,
              });
            } else {
              await runCodexBridge({
                client: relayClient(),
                media: { token: input.token, apiURL: input.apiURL, context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
                codex: await codexCommand(input.command, env),
                cwd: input.cwd,
                // The chat's Codex thread outlives this run, so a restart picks
                // every chat up where it stopped (codex-threads.ts).
                threads: await openCodexThreads({ apiURL: input.apiURL, handle: input.handle }, configContext),
                // Every thread gets Relay's hosted MCP server, which reads
                // its token from RELAY_AGENT_TOKEN (codex-bridge.ts).
                agentToken: input.token,
                mcpURL: input.mcpURL,
                approvals,
                signal: control.signal,
                say: input.say,
              });
            }
          } finally {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
          }
        },
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.offerSkill ? { offerSkill: dependencies.offerSkill } : {}),
        consoleLogin: dependencies.consoleLogin ?? (() => consoleLoginOrReuse({
          context: configContext,
          apiURL: defaultCreationApiURL(),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          // Console login has no prompts; Relay Console names a first
          // organization itself (GET /me).
          stderr,
          nonInteractive: dependencies.isInteractive === false,
        })),
        ...dependencies.connect,
      });
    });

  program
    .command("watch")
    .argument("[handle]", "the agent to watch")
    .description("see messages arrive and replies go out, live")
    .helpGroup(HELP_GROUPS.everyDay)
    .action(async (agentHandle: string | undefined, _options: object, command: Command) => {
      const auth = agentHandle === undefined
        ? await resolveAuth(globals(command).profile, configContext)
        : await selectAgentAuth(handle(agentHandle), globals(command).profile, agentDeps);
      if (!willShowSavedAgent(command)) {
        throw new Error("This view needs a terminal. In a script, read events with npx relaymessenger --profile <name> events listen --acknowledge-events instead.");
      }
      await openSavedAgentSession({
        profile: auth.profile, apiURL: auth.apiURL,
        ...(agentHandle ? { handle: handle(agentHandle) } : {}),
      }, {
        agents: agentDeps,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.terminalSession ? { session: dependencies.terminalSession } : {}),
        ...(dependencies.terminalIO ? { io: dependencies.terminalIO } : {}),
        ...(dependencies.terminalClient ? { client: dependencies.terminalClient } : {}),
      });
    });

  program
    .command("listen")
    .description("forward each event to a route on this computer")
    .helpGroup(HELP_GROUPS.everyDay)
    .requiredOption("--forward-to <url>", "local address for signed event copies")
    .action(async (options: { forwardTo: string }, command: Command) => {
      const context = await resolveClient(globals(command).profile);
      await forwardEvents({
        auth: context.auth,
        client: context.client,
        forwardTo: options.forwardTo,
        render: (event) => terminalEventLine(event, [context.auth.token]),
        banner: true,
      });
    });

  program
    .command("doctor")
    .description("check this computer and every saved agent")
    .helpGroup(HELP_GROUPS.everyDay)
    .option("--offline", "local checks only")
    .action(async (options: { offline?: boolean }, command: Command) => {
      const report = await runDoctor(
        {
          ...(globals(command).profile
            ? { profile: globals(command).profile }
            : {}),
          offline: options.offline ?? false,
        },
        {
          configContext,
          createClient: (resolved) => new Relay({
            apiKey: resolved.token,
            baseURL: resolved.apiURL,
            ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          }),
        },
      );
      output(report);
      if (!report.ok) throw new Error("Some checks did not pass. Each line above says what to fix.");
    });
};
