import { Command, Option } from "commander";
import { DOCS_LLMS_URL, docsSection, docsSections, readDocs } from "../agent-driver.js";
import {
  addRedirect,
  createOAuth,
  removeRedirect,
  resetSecret,
  setScopes,
  showOAuth,
} from "../agent-oauth.js";
import {
  configPath,
  defaultCreationApiURL,
  readConfig,
  resolveAuth,
  validateApiURL,
  validateProfileName,
  validateToken,
  writeConfig,
} from "../config.js";
import {
  ConsoleRefusal,
  consoleLoginOrReuse,
  consoleLoginWithKey,
  consoleRequest,
  consoleSignOut,
} from "../console-auth.js";
import { CliError } from "../error-codes.js";
import { HELP_GROUPS } from "../help-groups.js";
import { InteractiveCancelled } from "../interactive.js";
import { safeMetadata } from "../output.js";
import { linkPhone, phoneLinkSentence } from "../phone-link.js";
import { readHiddenToken } from "../secret-input.js";
import { globals, handle, type CommandContext } from "./context.js";

const OAUTH_HELP = `
Websites log people in with Relay through standard OpenID Connect. The
client ID is the agent's ID. Logging in lets the agent message the person.

Examples:
  relay oauth create weather
  relay oauth show weather
  relay oauth redirects add weather https://example.com/auth/relay/callback
  relay oauth redirects remove weather https://example.com/auth/relay/callback
  relay oauth scopes weather email phone
  relay oauth reset-secret weather
`;

export const registerAccountCommands = (program: Command, ctx: CommandContext): void => {
  const {
    dependencies,
    stdout,
    stderr,
    configContext,
    output,
    human,
    loggedIn,
    agentDeps,
    readStdinText,
    showSavedAgent,
    usageError,
    accessRequest,
  } = ctx;

  // Log in with Relay: the agent's OAuth2 client, Relay Console's OAuth2 tab.
  const oauth = program.command("oauth")
    .description("let websites log people in with Relay")
    .helpGroup(HELP_GROUPS.everythingElse);
  oauth.addHelpText("after", OAUTH_HELP);
  oauth.command("create").argument("<handle>", "agent handle", handle)
    .description("create the client and show its secret once")
    .option("--json", "JSON output")
    .action(async (agentHandle: string) => {
      output(await createOAuth(accessRequest, agentHandle));
    });
  oauth.command("show").argument("<handle>", "agent handle", handle)
    .description("show the client id, redirects and scopes")
    .option("--json", "JSON output")
    .action(async (agentHandle: string) => {
      output(await showOAuth(accessRequest, agentHandle));
    });
  const redirects = oauth.command("redirects").description("add or remove where Relay sends people back");
  redirects.command("add").argument("<handle>", "agent handle", handle).argument("<url>", "https redirect URL")
    .description("add a redirect")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, url: string) => {
      output(await addRedirect(accessRequest, agentHandle, url));
    });
  redirects.command("remove").argument("<handle>", "agent handle", handle).argument("<url>", "redirect URL")
    .description("remove a redirect")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, url: string) => {
      output(await removeRedirect(accessRequest, agentHandle, url));
    });
  oauth.command("scopes").argument("<handle>", "agent handle", handle).argument("[scopes...]", "email, phone, birthdate, or none")
    .description("set the optional scopes; openid and profile stay")
    .option("--json", "JSON output")
    .action(async (agentHandle: string, scopes: string[]) => {
      output(await setScopes(accessRequest, agentHandle, scopes));
    });
  oauth.command("reset-secret").argument("<handle>", "agent handle", handle)
    .description("make a new client secret, shown once")
    .option("--json", "JSON output")
    .action(async (agentHandle: string) => {
      output(await resetSecret(accessRequest, agentHandle));
    });

  // Optional: link a phone so this account is also the Relay app account.
  const phone = program.command("phone")
    .description("link your phone to your Relay account")
    .helpGroup(HELP_GROUPS.everythingElse);
  phone.command("link")
    .description("text a code to your phone and link it")
    .option("--number <number>", "your number, with its country code")
    .option("--code <code>", "the code from the text message")
    .option("--json", "JSON output")
    .addHelpText("after", `
Linking is optional. Once linked, the Relay app signs in to this same
account with your phone, and tool approvals from your connected agents
reach you there.

Without a terminal, run it twice: once with --number to get the code, then
again with --number and --code.
`)
    .action(async (options: { number?: string; code?: string }, command: Command) => {
      const interactive = !globals(command).nonInteractive && !globals(command).json && dependencies.isInteractive === true;
      const result = await linkPhone(options, {
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(interactive && dependencies.prompts ? { prompts: dependencies.prompts } : {}),
        stderr,
      });
      output(result);
      const sentence = phoneLinkSentence(result);
      if (sentence && !globals(command).json) stderr(`${sentence}\n`);
    });

  const authCommands = program.command("auth", { hidden: true }).description("manage the token this computer signs in with").helpGroup(HELP_GROUPS.everythingElse);
  authCommands.configureOutput({
    outputError: usageError,
  });
  const authLogin = async (
    options: { withToken?: boolean; apiUrl?: string },
    command: Command,
  ): Promise<void> => {
    const env = configContext.env ?? process.env;
    const config = await readConfig(configContext);
    const profile = validateProfileName(globals(command).profile ?? config.current_profile);
    const previous = config.profiles[profile] ?? {};
    let raw: string | undefined;
    if (options.withToken && !dependencies.readStdin && process.stdin.isTTY) {
      if (globals(command).nonInteractive || globals(command).json || dependencies.isInteractive === false) throw new CliError("Nothing is piped in. Pipe the token into this command, for example: echo \"$RELAY_AGENT_TOKEN\" | npx relaymessenger auth login --with-token", "not_a_tty");
      raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
    } else if (options.withToken) {
      raw = await readStdinText();
    } else if (env.RELAY_AGENT_TOKEN !== undefined) raw = env.RELAY_AGENT_TOKEN;
    else {
      const interactive = !globals(command).nonInteractive && !globals(command).json && (dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY));
      if (!interactive) throw new CliError("Relay has no token and cannot ask for one here. Pipe it into npx relaymessenger auth login --with-token, or set RELAY_AGENT_TOKEN.", "not_a_tty");
      raw = await (dependencies.readSecret ?? (() => readHiddenToken(process.stdin, stderr)))();
    }
    if (!raw) throw new Error("No token was given, so nothing was changed.");
    const token = validateToken(raw);
    const apiURL = validateApiURL(options.apiUrl ?? env.RELAY_API_URL ?? previous.api_url ?? defaultCreationApiURL());
    {
      try {
        const cards = await agentDeps.client(token, apiURL).contactCard.retrieve();
        if (cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active).length !== 1) throw new Error("This token must belong to exactly one active agent.");
      } catch { throw new Error("Relay would not accept this token. Nothing was changed: your saved token is as it was."); }
    }
    config.profiles[profile] = { api_url: apiURL, agent_token: token };
    await writeConfig(config, configContext);
    output(safeMetadata({ ok: true, profile, api_url: apiURL, token: "stored" }, [token]));
    await showSavedAgent(command, { profile, apiURL, runtime: { ownership: "unknown", connection: "unknown" } });
  };
  const authStatus = async (_options: object, command: Command, liveView = true): Promise<void> => {
    const resolved = await resolveAuth(globals(command).profile, configContext);
    if (human(command)) {
      stdout(`\u2713 Agent token: profile ${resolved.profile}, from ${resolved.tokenSource === "environment" ? "RELAY_AGENT_TOKEN" : resolved.configPath}\n`);
    } else output({
      configured: true,
      profile: resolved.profile,
      api_url: resolved.apiURL,
      token_source: resolved.tokenSource,
      config_path: resolved.configPath,
    });
    const saved = (await agentDeps.read()).profiles[resolved.profile];
    if (liveView && saved?.agent_token === resolved.token && validateApiURL(saved.api_url ?? defaultCreationApiURL()) === resolved.apiURL) {
      await showSavedAgent(command, { profile: resolved.profile, apiURL: resolved.apiURL });
    }
  };
  // gh's `gh auth token`: writes the token and a newline to stdout and nothing
  // else so scripts can run `export RELAY_AGENT_TOKEN=$(relay auth token)`.
  const authToken = async (_options: object, command: Command): Promise<void> => {
    const resolved = await resolveAuth(globals(command).profile, configContext);
    stdout(`${resolved.token}\n`);
  };
  const authLogout = async (_options: object, command: Command, clearConsole = false): Promise<void> => {
    if (!globals(command).nonInteractive && !globals(command).json && dependencies.confirmLogout && !await dependencies.confirmLogout()) throw new InteractiveCancelled();
    const config = await readConfig(configContext);
    const profile = validateProfileName(
      globals(command).profile ?? config.current_profile,
    );
    const selected = config.profiles[profile];
    if (!selected) throw new CliError(`Relay profile ${profile} does not exist.`, "not_found");
    const clearedConsole = clearConsole && config.console !== undefined;
    // End the Relay-Auth session on the server before the local copy goes;
    // a server miss still removes the local session (the token expires by itself).
    if (clearedConsole) {
      await consoleSignOut({ context: configContext, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
      delete config.console;
    }
    // clig.dev, Output: "If you change state, tell the user" — and only when
    // it changed. With nothing saved there is nothing to remove, so the
    // file is left alone and the answer says so (ledger row P14).
    if (selected.agent_token === undefined) {
      if (clearedConsole) await writeConfig(config, configContext);
      output({ ok: true, profile, token: "none", ...(clearedConsole ? { console: "removed" } : {}) });
      if (!clearedConsole && !globals(command).json && !globals(command).quiet) stderr(`No token was saved for profile ${profile}.\n`);
      return;
    }
    const { agent_token: _removed, ...withoutToken } = selected;
    config.profiles[profile] = withoutToken;
    await writeConfig(config, configContext);
    output({ ok: true, profile, token: "removed", ...(clearedConsole ? { console: "removed" } : {}) });
  };
  const addAuthLogin = (command: Command): void => {
    command
      .option("--with-token", "an existing token from a pipe")
      .addOption(new Option("--api-url <url>", "the Relay API address this profile uses").hideHelp())
      .action(authLogin);
  };
  const addAuthStatus = (command: Command): void => {
    command.action(authStatus);
  };
  const addAuthLogout = (command: Command): void => {
    command.action(authLogout);
  };
  const authLoginCommand = authCommands.command("login")
    .description("save a token for this computer");
  addAuthLogin(authLoginCommand);
  const authStatusCommand = authCommands.command("status")
    .description("show the token source without revealing the token");
  addAuthStatus(authStatusCommand);
  authCommands.command("token")
    .description("print the token, for a script")
    .action(authToken);
  const authLogoutCommand = authCommands.command("logout")
    .description("remove the selected profile's stored token");
  addAuthLogout(authLogoutCommand);

  // Linq-style top-level names; the hidden `auth` tree remains compatible with
  // existing scripts and is still the canonical implementation underneath.
  const loginCommand = program.command("login")
    .description("sign in to Relay Console")
    .helpGroup(HELP_GROUPS.everythingElse);
  loginCommand
    .option("--with-token", "an existing token from a pipe")
    .option("--website <domain>", "organization website; empty value clears it")
    .action(async (options: { withToken?: boolean; website?: string }, command: Command) => {
      if (options.withToken) {
        if (!dependencies.readStdin && process.stdin.isTTY) {
          throw new CliError("Pipe an organization API key into relay login --with-token.", "not_a_tty");
        }
        const session = await consoleLoginWithKey({
          context: configContext,
          apiURL: defaultCreationApiURL(),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        }, await readStdinText());
        if (human(command)) { stdout(await loggedIn(session)); return; }
        output(safeMetadata(
          { ok: true, type: session.type, organization_id: session.organization_id, token: "stored" },
          [session.organization_key],
        ));
        return;
      }
      const session = await consoleLoginOrReuse({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.prompts ? { prompts: dependencies.prompts } : {}),
        stderr,
        ...(options.website === undefined ? {} : { website: options.website }),
        nonInteractive: false,
        human: human(command),
        ...(dependencies.openBrowser ? { openBrowser: dependencies.openBrowser } : {}),
      });
      if (human(command)) { stdout(await loggedIn(session)); return; }
      output({
        ok: true,
        ...(session.type === "organization_key" ? { type: session.type } : { user: session.user }),
        organization_id: session.organization_id,
        token: "stored",
      });
    });

  const whoamiCommand = program.command("whoami")
    .description("show who is signed in, without the token")
    .helpGroup(HELP_GROUPS.everythingElse);
  whoamiCommand.action(async (options: object, command: Command) => {
    const current = (await readConfig(configContext)).console;
    if (human(command)) {
      // gh auth status: the account first, then the agent token this folder uses.
      const signedIn = current !== undefined && !globals(command).profile;
      if (signedIn) stdout(await loggedIn(current));
      try { await authStatus(options, command, false); }
      catch (error) { if (!signedIn || !(error instanceof CliError) || error.code !== "no_token") throw error; }
      return;
    }
    if (current?.type === "organization_key" && !globals(command).profile) {
      const me = await consoleRequest<{ org: { id: string } }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      if (human(command)) { stdout(await loggedIn(current)); return; }
      output({ type: current.type, organization_id: me.org.id });
      return;
    }
    try {
      // whoami names who is signed in and stops (gh auth status); the live
      // view's full-screen repaint stays with `auth status` and create.
      await authStatus(options, command, false);
    } catch (error) {
      // A successful Console login does not create an Agent Token. Preserve
      // existing agent/profile behavior, but report that signed-in identity
      // rather than telling a Console-only user to paste another token.
      if (!(error instanceof CliError) || error.code !== "no_token") throw error;
      if (globals(command).profile) throw error;
      const config = await readConfig(configContext);
      if (!config.console) throw error;
      const me = await consoleRequest<{
        user: { id: string; email: string; name?: string };
        org: { id: string };
      }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      if (human(command)) { stdout(await loggedIn(config.console)); return; }
      output({
        user: { id: me.user.id, email: me.user.email, ...(me.user.name ? { name: me.user.name } : {}) },
        organization_id: me.org.id,
      });
    }
  });

  const logoutCommand = program.command("logout")
    .description("remove the saved sign-in")
    .helpGroup(HELP_GROUPS.everythingElse);
  logoutCommand.action((options: object, command: Command) => authLogout(options, command, true));

  // Relay Console's POST /me/beta invites through App Store Connect.
  // A user session only: the route refuses organization keys.
  program.command("beta")
    .description("join Relay's TestFlight beta for new features first")
    .option("--email <apple-id>", "Apple ID email, if not your account's")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(async (options: { email?: string }, command: Command) => {
      const session = (await readConfig(configContext)).console;
      if (!session) throw new CliError("Relay Console is not signed in. Run relay login.", "no_token");
      if (session.type === "organization_key") {
        throw new CliError("The beta needs your own sign-in, not an organization API key. Run relay login.", "no_token");
      }
      let invite: { result: "invited" | "already"; apple_id_email: string };
      try {
        invite = await accessRequest("/me/beta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.email === undefined ? {} : { apple_id_email: options.email }),
        });
      } catch (error) {
        if (!(error instanceof ConsoleRefusal)) throw error;
        if (error.code === "invalid_email") {
          // A phone sign-in has no real account email (Console stores a
          // reserved placeholder), so the person names their Apple ID.
          throw new CliError(options.email === undefined
            ? "Your account has no email Apple can use. Run relay beta --email <your Apple ID email>."
            : "Enter a valid email.", "usage");
        }
        if (error.code === "beta_email_taken") {
          throw new CliError(`The beta was already sent to ${error.appleIdEmail ?? "another email"}.`, "refused");
        }
        if (error.status === 502) {
          throw new CliError(error.code === "staging_outbound_disabled"
            ? "Beta invites are not sent from this environment."
            : "Apple could not send the invite. Try again later.", "refused");
        }
        throw error;
      }
      if (!human(command)) { output(invite); return; }
      stdout(invite.result === "already"
        ? `${invite.apple_id_email} is already in the Relay beta.\n`
        : `Invited ${invite.apple_id_email} to the Relay beta. Open the TestFlight email on your iPhone.\n`);
    });

  const organization = program.command("organization")
    .alias("org")
    .description("manage the signed-in organization")
    .helpGroup(HELP_GROUPS.everythingElse);
  organization.command("show")
    .description("show the signed-in organization")
    .action(async () => {
      output(await consoleRequest({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me"));
    });
  organization.command("update")
    .description("change the organization name or website")
    .option("--name <name>", "the display name")
    .option("--website <domain>", "organization website; empty value clears it")
    .action(async (options: { name?: string; website?: string }) => {
      if (options.name === undefined && options.website === undefined) {
        throw new CliError("Choose --name or --website.", "usage");
      }
      const me = await consoleRequest<{ org: { id: string } }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      output(await consoleRequest({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, `/orgs/${me.org.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.website === undefined ? {} : { website: options.website }),
        }),
      }));
    });

  const profiles = program.command("profiles", { hidden: true }).description("add, use, remove and list saved profiles").helpGroup(HELP_GROUPS.everythingElse);
  profiles
    .command("add")
    .argument("<name>", "profile name", validateProfileName)
    .addOption(new Option("--api-url <url>", "the Relay API address this profile uses")
      .argParser(validateApiURL).makeOptionMandatory().hideHelp())
    .description("add a profile without a token")
    .action(async (name: string, options: { apiUrl: string }) => {
      const config = await readConfig(configContext);
      if (config.profiles[name]) throw new Error(`Relay profile ${name} already exists.`);
      config.profiles[name] = { api_url: options.apiUrl };
      await writeConfig(config, configContext);
      output({ ok: true, profile: name, api_url: options.apiUrl });
    });
  profiles
    .command("use")
    .argument("<name>", "profile name", validateProfileName)
    .description("select the current profile")
    .action(async (name: string) => {
      const config = await readConfig(configContext);
      if (!config.profiles[name]) throw new CliError(`Relay profile ${name} does not exist.`, "not_found");
      config.current_profile = name;
      await writeConfig(config, configContext);
      output({ ok: true, current_profile: name });
    });
  profiles
    .command("remove")
    .argument("<name>", "profile name", validateProfileName)
    .description("remove a profile that is not current")
    .action(async (name: string) => {
      const config = await readConfig(configContext);
      if (name === config.current_profile) {
        throw new Error("Cannot remove the current profile; select another first.");
      }
      if (!config.profiles[name]) throw new CliError(`Relay profile ${name} does not exist.`, "not_found");
      delete config.profiles[name];
      await writeConfig(config, configContext);
      output({ ok: true, removed: name });
    });
  profiles
    .command("list")
    .description("list profiles without their tokens")
    .action(async () => {
      const config = await readConfig(configContext);
      output({
        current_profile: config.current_profile,
        profiles: Object.entries(config.profiles).map(([name, profile]) => ({
          name,
          current: name === config.current_profile,
          api_url: profile.api_url ?? defaultCreationApiURL(),
          has_token: Boolean(profile.agent_token),
        })),
      });
    });

  program
    .command("docs", { hidden: true })
    .argument("[section]", "documentation section")
    .option("--list", "section names, one per line")
    .description("read Relay documentation or show its address")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(async (section: string | undefined, options: { list?: boolean }, command: Command) => {
      const fetchDocs = () => readDocs(dependencies.fetch ?? globalThis.fetch);
      // Anthropic's pagination rule for a response that could fill the context:
      // the names, or one section, on request.
      if (options.list || section !== undefined) {
        const text = await fetchDocs();
        if (text === undefined) throw new CliError(`Relay's documentation could not be read from ${DOCS_LLMS_URL}.`, "network");
        if (options.list) {
          const names = docsSections(text);
          if (globals(command).json) output({ sections: names });
          else stdout(`${names.join("\n")}\n`);
          return;
        }
        const chosen = docsSection(text, section!);
        if (chosen === undefined) throw new CliError(`There is no documentation section named ${section}. Run npx relaymessenger docs --list to see the names.`, "not_found");
        if (globals(command).json) output({ section, text: chosen });
        else stdout(chosen);
        return;
      }
      // A person gets the address to open. An agent, which has no terminal, gets
      // the text itself in one request, the way Railway prints its llms.txt.
      const headless = dependencies.isInteractive === false
        || (dependencies.isInteractive === undefined && !process.stdout.isTTY);
      if (globals(command).json) { output({ url: DOCS_LLMS_URL }); return; }
      const text = headless ? await fetchDocs() : undefined;
      stdout(text ?? `${DOCS_LLMS_URL}\n`);
    });

  program
    .command("config-path", { hidden: true })
    .description("show where Relay keeps its config file")
    .helpGroup(HELP_GROUPS.everythingElse)
    .action(() => output({ path: configPath(configContext) }));
};
