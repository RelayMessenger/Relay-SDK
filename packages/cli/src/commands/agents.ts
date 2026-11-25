import type { AgentImageRecipe } from "@relaymessenger/sdk";
import { Command, Option } from "commander";
import {
  AGENTS_CAN_MESSAGE,
  peopleSwitch,
  removeAccess,
  setAccess,
  setReachPreset,
  showAccess,
  updateReach,
  type AgentsCanMessage,
} from "../agent-access.js";
import {
  createAgentWithPicture,
  incompletePictureMessage,
  requireSubtitle,
} from "../agent-create.js";
import {
  deleteAgent,
  listAgents,
  selectAgentAuth,
  validateFirstName,
  validateHandle,
} from "../agents.js";
import {
  configPath,
  defaultCreationApiURL,
  validateApiURL,
  validateProfileName,
} from "../config.js";
import { consoleLoginOrReuse, deleteConsoleAgent } from "../console-auth.js";
import { HELP_GROUPS } from "../help-groups.js";
import { InteractiveCancelled } from "../interactive.js";
import { safeMetadata } from "../output.js";
import { renderTerminalQRForOutput, TerminalQRSizeError } from "../qr-terminal.js";
import {
  descriptionText,
  globals,
  handle,
  readImageRecipe,
  subtitleText,
  type CommandContext,
} from "./context.js";

const ACCESS_HELP = `
People in your organization can always message the agent, whatever these
settings say. Private turns people off and sets other agents to nobody, so
only your organization and the handles on Always Allow can start a chat.
Open turns both back on; agents are open by default. Ongoing conversations
continue whatever you choose.

Examples:
  relay agents access show weather
  relay agents access private weather
  relay agents access open weather
  relay agents access update weather --people off --agents nobody
  relay agents access allow weather alice
  relay agents access deny weather spam_bot
  relay agents access remove weather alice
`;

export const registerAgentsCommands = (program: Command, ctx: CommandContext): void => {
  const {
    dependencies,
    stdout,
    stderr,
    configContext,
    output,
    human,
    agentDeps,
    willShowSavedAgent,
    showSavedAgent,
    accessRequest,
  } = ctx;

  const agents = program.command("agents")
    .description("create, update, list and delete saved agents")
    .helpGroup(HELP_GROUPS.everyDay);

  agents.command("create")
    .description("create an agent and save its token privately")
    .addOption(new Option("--api-url <url>", "the Relay API address to use").argParser(validateApiURL).hideHelp())
    .option("--handle <handle>", "the agent's handle")
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .option("--image <path-or-url>", "a picture file or https:// address")
    .option("--image-url <url>", "a picture at an https:// address")
    .option("--image-recipe <json-file>", "a Relay picture recipe accompanying the picture")
    .option("--json", "JSON output")
    .action(async (options: { apiUrl?: string; json?: boolean; handle?: string; name?: string; subtitle?: string; description?: string; image?: string; imageUrl?: string; imageRecipe?: string }, command: Command) => {
      if (options.handle !== undefined) validateHandle(options.handle);
      if (options.name !== undefined) validateFirstName(options.name);
      if (options.image !== undefined && options.imageUrl !== undefined) throw new Error("Choose --image or --image-url, not both.");
      const imageRecipe: AgentImageRecipe | undefined = options.imageRecipe === undefined
        ? undefined : await readImageRecipe(options.imageRecipe);
      const requestedProfile = program.getOptionValueSource("profile") === "cli"
        ? globals(command).profile : undefined;
      if (requestedProfile) {
        validateProfileName(requestedProfile);
        if (Object.hasOwn((await agentDeps.read()).profiles, requestedProfile)) {
          throw new Error("Profile already exists; choose a new profile name.");
        }
      }
      options.subtitle = await requireSubtitle(options.subtitle, {
        prompts: dependencies.prompts,
        nonInteractive: globals(command).nonInteractive === true || options.json === true || globals(command).json === true || dependencies.isInteractive === false,
      });
      const session = await (dependencies.consoleLogin?.() ?? consoleLoginOrReuse({
        context: configContext,
        apiURL: options.apiUrl ?? defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.prompts ? { prompts: dependencies.prompts } : {}),
        stderr,
        nonInteractive: globals(command).nonInteractive === true || globals(command).json === true || dependencies.isInteractive === false,
      }));
      const created = await createAgentWithPicture({
        makeDefault: true,
        ...(program.getOptionValueSource("profile") === "cli" && globals(command).profile ? { profile: globals(command).profile } : {}),
        apiURL: options.apiUrl ?? defaultCreationApiURL(),
        ...(options.handle === undefined ? {} : { handle: options.handle }),
        ...(options.name === undefined ? {} : { firstName: options.name }),
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageUrl === undefined ? {} : { imageURL: options.imageUrl }),
        ...(imageRecipe === undefined ? {} : { imageRecipe }),
        ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
        ...(configContext.home ? { home: configContext.home } : {}),
      }, agentDeps, dependencies.fetch);
      const result = { ...created.result, organization_id: session.organization_id };
      const imageUpdate = created.image;
      if (globals(command).json) output({ ...result, ...(imageUpdate ? { image: imageUpdate } : {}) });
      else {
        stdout(`${human(command) ? "\u2713 Created " : ""}${result.display_name} (@${result.handle})\nProfile: ${result.profile}\n${result.share_url}\nToken saved in ${configPath(configContext)}\nPrint it with \`relay auth token --profile ${result.profile}\`.\n`);
        const liveViewFollows = imageUpdate?.status !== "incomplete" && willShowSavedAgent(command);
        if (!liveViewFollows) {
          try { stdout(renderTerminalQRForOutput(result.share_url)); }
          catch (error) {
            stderr(error instanceof TerminalQRSizeError
              ? `${error.message}\n`
              : "Relay could not draw the QR code. Use the link above instead.\n");
          }
        }
        if (imageUpdate?.status === "incomplete") output({ image: imageUpdate });
      }
      if (imageUpdate?.status !== "incomplete") {
        await showSavedAgent(command, {
          profile: result.profile, handle: result.handle, apiURL: result.api_url, shareURL: result.share_url,
          runtime: { ownership: "none", connection: "not-started" },
        });
      }
      if (imageUpdate?.status === "incomplete") {
        throw new Error(incompletePictureMessage(result.handle, result.profile, imageUpdate, imageRecipe !== undefined));
      }
    });

  agents.command("list")
    .description("list the agents saved on this computer")
    .option("--json", "JSON output")
    .action(async (_options: object, command: Command) => {
      let firstFailure: Error | undefined;
      const result = await listAgents(agentDeps, (error) => { firstFailure ??= error; });
      if (human(command)) {
        // gh repo list: one row per thing, the name first.
        const rows = result.agents as Array<{ profile: string; handle?: string; display_name?: string; error?: string }>;
        stdout(rows.length === 0
          ? "No agents are saved on this computer. Create one with relaymessenger agents create.\n"
          : rows.map((row) => row.handle
            ? `@${row.handle}  ${row.display_name ?? ""}  (profile ${row.profile})\n`
            : `${row.profile}  could not be read: ${row.error ?? "unknown error"}\n`).join(""));
      } else output(result);
      // Keep successful entries on stdout; the first failed entry determines
      // the standard stderr envelope and classified command exit.
      if (firstFailure) throw firstFailure;
    });

  agents.command("update").argument("<handle>", "agent handle", handle)
    .description("update an agent's name or subtitle")
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .option("--json", "JSON output")
    .action(async (agentHandle: string, options: { name?: string; subtitle?: string; description?: string }, command: Command) => {
      const body = {
        handle: agentHandle,
        ...(options.name === undefined ? {} : { first_name: validateFirstName(options.name) }),
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        ...(options.description === undefined ? {} : { description: options.description }),
      };
      if (Object.keys(body).length === 1) throw new Error("Choose --name, --subtitle or --description.");
      const auth = await selectAgentAuth(agentHandle, globals(command).profile, agentDeps);
      await agentDeps.client(auth.token, auth.apiURL).contactCard.update(body, { maxRetries: 0 });
      output(safeMetadata({ ok: true, handle: agentHandle, profile: auth.profile, token: "unchanged" }, [auth.token]));
    });

  agents.command("delete").argument("<handle>", "agent handle", handle)
    .description("delete an agent and remove its saved token")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, _options: object, command: Command) => {
      if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmDelete && !await dependencies.confirmDelete()) throw new InteractiveCancelled();
      const deleted = await deleteAgent(agentHandle, globals(command).profile, {
        ...agentDeps,
        deleteConsole: (agentToDelete, apiURL, agentToken) => deleteConsoleAgent({
          context: configContext, apiURL,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        }, agentToDelete, agentToken),
      });
      if (human(command)) stdout(`\u2713 Deleted @${agentHandle}\n`);
      else output(deleted);
    });

  // Who may start a chat with an agent: Relay Console's "Available to" field
  // and its Always Allow and Never Allow lists, through the Console's own routes.
  const access = agents.command("access")
    .description("show and change who can message an agent");
  access.addHelpText("after", ACCESS_HELP);
  access.command("show").argument("<handle>", "agent handle", handle)
    .description("show who can start a chat with an agent")
    .option("--json", "JSON output")
    .action(async (agentHandle: string) => {
      output(await showAccess(accessRequest, agentHandle));
    });
  access.command("update").argument("<handle>", "agent handle", handle)
    .description("change who can start a chat with an agent")
    .addOption(new Option("--people <on|off>", "People in the Relay app").argParser(peopleSwitch))
    .addOption(new Option("--agents <who>", "Other agents").choices(AGENTS_CAN_MESSAGE))
    .option("--json", "JSON output")
    .addHelpText("after", ACCESS_HELP)
    .action(async (agentHandle: string, options: { people?: boolean; agents?: AgentsCanMessage }) => {
      output(await updateReach(accessRequest, agentHandle, {
        ...(options.people === undefined ? {} : { people: options.people }),
        ...(options.agents === undefined ? {} : { agents: options.agents }),
      }));
    });
  access.command("private").argument("<handle>", "agent handle", handle)
    .description("let only your organization and Always Allow message it")
    .option("--json", "JSON output")
    .addHelpText("after", ACCESS_HELP)
    .action(async (agentHandle: string) => {
      output(await setReachPreset(accessRequest, agentHandle, "private"));
    });
  access.command("open").argument("<handle>", "agent handle", handle)
    .description("let people and other agents message it")
    .option("--json", "JSON output")
    .addHelpText("after", ACCESS_HELP)
    .action(async (agentHandle: string) => {
      output(await setReachPreset(accessRequest, agentHandle, "open"));
    });
  access.command("allow").argument("<handle>", "agent handle", handle).argument("<contact>", "person's or agent's handle")
    .description("put a person or agent on Always Allow")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, contact: string) => {
      output(await setAccess(accessRequest, agentHandle, contact, "allow"));
    });
  access.command("deny").argument("<handle>", "agent handle", handle).argument("<contact>", "person's or agent's handle")
    .description("put a person or agent on Never Allow")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, contact: string) => {
      output(await setAccess(accessRequest, agentHandle, contact, "deny"));
    });
  access.command("remove").argument("<handle>", "agent handle", handle).argument("<contact>", "person's or agent's handle")
    .description("take a person or agent off both lists")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, contact: string) => {
      output(await removeAccess(accessRequest, agentHandle, contact));
    });
};
