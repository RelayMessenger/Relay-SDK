import type Relay from "@relaymessenger/sdk";
import type {
  ContactCardCreateParams,
  ContactCardUpdateParams,
  WebhookSubscriptionUpdateParams,
} from "@relaymessenger/sdk";
import { Command, Option } from "commander";
import { uploadAgentImage } from "../agent-image-upload.js";
import { cardHandle } from "../agents.js";
import { DEFAULT_API_URL } from "../config.js";
import { HELP_GROUPS } from "../help-groups.js";
import { prepareAgentImage } from "../local-image.js";
import { safeMetadata } from "../output.js";
import {
  descriptionText,
  events,
  globals,
  handle,
  nonempty,
  readImageRecipe,
  subtitleText,
  voidResult,
  type CommandContext,
} from "./context.js";

export const registerWebhooksAndContactCardCommands = (
  program: Command,
  ctx: CommandContext,
): void => {
  const {
    dependencies,
    configContext,
    resolveClient,
    output,
    clientFor,
    forwardEvents,
  } = ctx;

  const webhooks = program.command("webhooks", { hidden: true }).description("list event types and manage where they go").helpGroup(HELP_GROUPS.everythingElse);
  webhooks
    .command("events")
    .description("list every event type Relay can send")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookEvents.list()));

  // `watch` is the live view a person means. `events listen` is a different
  // thing wearing a similar name: it takes events, so Relay can stop resending
  // them elsewhere. It keeps its flags and its behaviour, and leaves the help.
  program
    .command("events", { hidden: true })
    .description("watch events with the older command name")
    .helpGroup(HELP_GROUPS.unlisted)
    .command("listen")
    .option("--forward-to <url>", "local address for signed event copies")
    .requiredOption(
      "--acknowledge-events",
      "mark test-agent events as read",
    )
    .description("print incoming events and optionally forward signed copies")
    .action(async (
      options: { forwardTo?: string; acknowledgeEvents: boolean },
      command: Command,
    ) => {
      const requestedProfile = globals(command).profile;
      if (!requestedProfile) {
        throw new Error(
          "Name the test agent to watch with --profile. This command will not guess.",
        );
      }
      const context = await resolveClient(requestedProfile);
      if (context.auth.apiURL === DEFAULT_API_URL) {
        throw new Error(
          "This command only works against a test Relay API, never the live one. Use a profile pointed at staging.",
        );
      }
      await forwardEvents({
        auth: context.auth,
        client: context.client,
        ...(options.forwardTo ? { forwardTo: options.forwardTo } : {}),
        banner: false,
      });
    });

  const subscriptions = webhooks.command("subscriptions").description("manage webhook subscriptions");
  subscriptions
    .command("list")
    .description("list where Relay sends this agent's events")
    .action(async (_options: object, command: Command) =>
      output(await (await clientFor(command)).webhookSubscriptions.list()));
  subscriptions
    .command("get")
    .description("show one webhook subscription")
    .argument("<subscription-id>", "the webhook subscription ID")
    .action(async (subscriptionID: string, _options: object, command: Command) =>
      output(
        await (await clientFor(command)).webhookSubscriptions.retrieve(
          subscriptionID,
        ),
      ));
  subscriptions
    .command("create")
    .description("send chosen events to an address you own")
    .requiredOption("--target-url <url>", "the address that receives webhook events")
    .requiredOption("--event <events...>", "the event types this subscription receives")
    .action(async (
      options: { targetUrl: string; event: string[] },
      command: Command,
    ) => output(
      await (await clientFor(command)).webhookSubscriptions.create({
        target_url: options.targetUrl,
        subscribed_events: events(options.event),
      }),
    ));
  subscriptions
    .command("update")
    .description("change a subscription's address, events or state")
    .argument("<subscription-id>", "the webhook subscription ID")
    .option("--target-url <url>", "the address that receives webhook events")
    .option("--event <events...>", "the event types this subscription receives")
    .option("--active", "delivery enabled")
    .option("--inactive", "delivery disabled")
    .action(async (
      subscriptionID: string,
      options: {
        targetUrl?: string;
        event?: string[];
        active?: boolean;
        inactive?: boolean;
      },
      command: Command,
    ) => {
      if (options.active && options.inactive) {
        throw new Error("Choose --active or --inactive, not both.");
      }
      const body = {
        ...(options.targetUrl ? { target_url: options.targetUrl } : {}),
        ...(options.event ? { subscribed_events: events(options.event) } : {}),
        ...(options.active
          ? { is_active: true }
          : options.inactive
          ? { is_active: false }
          : {}),
      } satisfies WebhookSubscriptionUpdateParams;
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to change. Pass --target-url, --event, --active or --inactive.");
      }
      output(
        await (await clientFor(command)).webhookSubscriptions.update(
          subscriptionID,
          body,
        ),
      );
    });
  subscriptions
    .command("delete")
    .description("stop sending events to that address")
    .argument("<subscription-id>", "the webhook subscription ID")
    .action(async (subscriptionID: string, _options: object, command: Command) => {
      await (await clientFor(command)).webhookSubscriptions.delete(subscriptionID);
      output(voidResult);
    });

  const contactCard = program.command("contact-card", { hidden: true }).description("set the name and picture people see").helpGroup(HELP_GROUPS.everythingElse);
  contactCard
    .command("get")
    .description("show this agent's name and picture")
    .option("--handle <handle>", "the agent's handle", handle)
    .action(async (options: { handle?: string }, command: Command) =>
      output(await (await clientFor(command)).contactCard.retrieve(options)));
  const contactCardHandle = async (client: Relay, explicit?: string): Promise<string> => {
    if (explicit) return explicit;
    const cards = await client.contactCard.retrieve({});
    const agents = cards.contact_cards.filter((card) => card.kind === "agent" && card.is_active);
    if (agents.length !== 1) throw new Error("This token must belong to exactly one active agent.");
    return cardHandle(agents[0]!);
  };
  contactCard
    .command("setup")
    .description("set this agent's name and picture the first time")
    .option("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the display name")
    .addOption(new Option("--first-name <name>", "the display name").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--image-url <url>", "a picture at an https:// address")
    .action(async (
      options: {
        handle?: string;
        name?: string; subtitle?: string; description?: string;
        firstName?: string;
        lastName?: string;
        imageUrl?: string;
      },
      command: Command,
    ) => {
      const selected = await resolveClient(globals(command).profile);
      const client = selected.client;
      const body = {
        handle: await contactCardHandle(client, options.handle),
        first_name: nonempty("Name", options.name ?? options.firstName ?? ""),
        ...(options.lastName ? { last_name: options.lastName } : {}),
        ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
      } satisfies ContactCardCreateParams;
      output(await client.contactCard.create(body));
    });
  contactCard
    .command("update")
    .alias("set")
    .description("change this agent's name or picture")
    .option("--handle <handle>", "the agent's handle", handle)
    .option("--name <name>", "the display name")
    .option("--subtitle <text>", "the line under the agent's name, 60 characters", subtitleText)
    .option("--description <text>", "what it can do, 2000 characters", descriptionText)
    .addOption(new Option("--first-name <name>", "the display name").hideHelp())
    .option("--last-name <name>", "an optional second name")
    .option("--clear-last-name", "no second name")
    .option("--image <path-or-url>", "a picture file or https:// address")
    .option("--image-url <url>", "a picture at an https:// address")
    .option("--attachment-id <id>", "the completed attachment")
    .option("--image-recipe <json-file>", "a Relay picture recipe accompanying the picture")
    .option("--clear-image-url", "no picture")
    .action(async (
      options: {
        handle?: string;
        name?: string; subtitle?: string; description?: string;
        firstName?: string;
        lastName?: string;
        clearLastName?: boolean;
        image?: string;
        imageUrl?: string;
        attachmentId?: string;
        imageRecipe?: string;
        clearImageUrl?: boolean;
      },
      command: Command,
    ) => {
      if (options.lastName && options.clearLastName) {
        throw new Error("Choose --last-name or --clear-last-name, not both.");
      }
      if ([options.image, options.imageUrl, options.attachmentId, options.clearImageUrl || undefined].filter((value) => value !== undefined).length > 1) throw new Error("Choose one image input or --clear-image-url.");
      const image = options.image === undefined ? undefined : await prepareAgentImage(options.image, {
        ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}), ...(configContext.home ? { home: configContext.home } : {}),
      });
      const imageURL = image?.kind === "url" ? image.url : options.imageUrl;
      if (options.imageRecipe && !image && !options.imageUrl && !options.attachmentId) throw new Error("--image-recipe requires a rendered image URL, file, or completed attachment.");
      const recipe = options.imageRecipe ? await readImageRecipe(options.imageRecipe) : undefined;
      const selected = await resolveClient(globals(command).profile);
      const client = selected.client;
      const body = {
        handle: await contactCardHandle(client, options.handle),
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...((options.name ?? options.firstName) ? { first_name: (options.name ?? options.firstName)! } : {}),
        ...(options.lastName
          ? { last_name: options.lastName }
          : options.clearLastName
          ? { last_name: null }
          : {}),
        ...(imageURL
          ? { image_url: imageURL }
          : options.clearImageUrl
          ? { image_url: null }
          : {}),
        ...(recipe ? { image_recipe: recipe } : {}),
      } satisfies ContactCardUpdateParams;
      if (image?.kind === "file" || options.attachmentId) {
        const rawOutcome = await uploadAgentImage({ handle: body.handle,
          ...(image?.kind === "file" ? { image: image.file } : {}), ...(options.attachmentId ? { attachmentID: options.attachmentId } : {}),
        }, client, (attachmentID) => client.contactCard.update({ ...body, attachment_id: attachmentID }, { maxRetries: 0 }));
        const outcome = safeMetadata(rawOutcome, [selected.auth.token]);
        if (outcome.status === "updated") output(outcome.agent);
        else { output({ image: outcome }); throw new Error("The picture did not go through. Keep this profile and run this same update again; do not create another agent."); }
        return;
      }
      if (Object.keys(body).length === 1) {
        throw new Error("Nothing to change. Pass --name, --last-name, a picture option, or one of the --clear options.");
      }
      output(await client.contactCard.update(body));
    });
  contactCard
    .command("share")
    .description("share a contact card into a chat")
    .argument("<chat-id>", "the chat ID")
    .option("--handle <handle>", "share this agent's card instead of yours",
      (value: string) => handle(value).toLowerCase())
    .option("--user-id <id>", "share this person's card instead of yours")
    .action(async (chatID: string, options: { handle?: string; userId?: string }, command: Command) => {
      if (options.handle !== undefined && options.userId !== undefined) {
        throw new Error("Choose --handle or --user-id, not both.");
      }
      const client = await clientFor(command);
      if (options.handle !== undefined) await client.chats.shareContactCard(chatID, { handle: options.handle });
      else if (options.userId !== undefined) await client.chats.shareContactCard(chatID, { user_id: nonempty("User ID", options.userId) });
      else await client.chats.shareContactCard(chatID);
      output(voidResult);
    });
};
