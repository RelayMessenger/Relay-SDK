import { readFile, stat } from "node:fs/promises";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type AgentImageRecipe,
  type RelayWebhookEvent,
  type WebhookEventType,
} from "@relaymessenger/sdk";
import { Command, InvalidArgumentError } from "commander";
import { AGENT_MODES } from "../agent-driver.js";
import {
  openSavedAgentSession,
  type AgentSessionDependencies,
  type AgentSessionInput,
} from "../agent-session.js";
import { agentDependencies, type AgentDependencies } from "../agents.js";
import { createClientContext, type ClientContext } from "../client.js";
import {
  defaultCreationApiURL,
  localWebhookSecret,
  validateForwardURL,
  type ConfigContext,
  type RelayConsoleSession,
  type ResolvedAuth,
} from "../config.js";
import { consoleRequest } from "../console-auth.js";
import { listenForAgentEvents } from "../event-listen.js";
import { docsLine } from "../help-groups.js";
import type { InteractivePrompts } from "../interactive.js";
import { jsonText } from "../output.js";
import { dim, link } from "../ui-colour.js";
import type { UpdateCheck } from "../update-check.js";

export interface ProgramDependencies {
  agents?: AgentDependencies;
  configContext?: ConfigContext;
  resolveClient?: (profile?: string) => Promise<ClientContext>;
  readStdin?: () => Promise<string>;
  readSecret?: () => Promise<string>;
  isInteractive?: boolean;
  prompts?: InteractivePrompts;
  skillPresent?: () => Promise<boolean | "unknown">;
  skillInstaller?: () => Promise<void>;
  cwd?: string;
  confirmDelete?: () => Promise<boolean>;
  confirmLogout?: () => Promise<boolean>;
  /** The one Relay skill offer of a run, made at the end of a connect and nowhere else. */
  offerSkill?: () => Promise<void>;
  connect?: Partial<
    Pick<
      import("../connect.js").ConnectDependencies,
      "sniff" | "runCommand" | "startCommand" | "observer" | "bridge" | "renderQR" | "version" | "drivingAgent"
    >
  >;
  /** Which runtime is driving this command; `@vercel/detect-agent` by default. */
  detectAgent?: () => Promise<import("@vercel/detect-agent").AgentResult>;
  terminalSession?: AgentSessionDependencies["session"];
  terminalIO?: AgentSessionDependencies["io"];
  terminalClient?: AgentSessionDependencies["client"];
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetch?: typeof fetch;
  /** Test/integration seam for the Console device-login flow. */
  consoleLogin?: () => Promise<RelayConsoleSession>;
  consoleRequest?: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** `--json` was asked for, so commander's own usage text stays off the streams. */
  json?: boolean;
  /** Override the process TTY check in focused tests. */
  helpTTY?: boolean;
  /** A pre-rendered root heading, normally supplied only for TTY animation. */
  helpHeading?: string;
  /** The update check of this run; `false` turns it off. Built from the registry by default. */
  updateCheck?: UpdateCheck | false;
  /** Whether this copy was run from npx's cache; read from the script path by default. */
  fromNpx?: boolean;
  /** A person reads stdout (a terminal, no agent, no --json): print sentences, not JSON. */
  humanOutput?: boolean;
  /** Opens the sign-in page; the system browser by default. */
  openBrowser?: (url: string) => Promise<void>;
}

export interface GlobalOptions {
  profile?: string;
  json?: boolean;
  nonInteractive?: boolean;
  agent?: string;
  quiet?: boolean;
  verbose?: boolean;
}

export interface ForwardEventsInput {
  auth: ResolvedAuth;
  client: Relay;
  forwardTo?: string;
  render?: (event: RelayWebhookEvent) => string;
  banner: boolean;
}

export interface CommandContext {
  dependencies: ProgramDependencies;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  configContext: ConfigContext;
  resolveClient: (profile?: string) => Promise<ClientContext>;
  output: (value: unknown) => void;
  human: (command: Command) => boolean;
  loggedIn: (session: RelayConsoleSession) => Promise<string>;
  clientFor: (command: Command) => Promise<Relay>;
  agentDeps: AgentDependencies;
  readStdinText: () => Promise<string>;
  willShowSavedAgent: (command: Command) => boolean;
  showSavedAgent: (command: Command, input: AgentSessionInput) => Promise<void>;
  usageError: (message: string, write: (value: string) => void) => void;
  accessRequest: <T>(path: string, init?: RequestInit) => Promise<T>;
  forwardEvents: (input: ForwardEventsInput) => Promise<void>;
}

export const agentModeValue = (value: string): string => {
  if (!(AGENT_MODES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError("Expected auto, yes or no.");
  }
  return value;
};

export const subtitleText = (value: string): string => {
  const text = value.trim();
  if (!text || [...text].length > 60) {
    throw new InvalidArgumentError("Subtitle must be 1 to 60 characters.");
  }
  return text;
};

export const descriptionText = (value: string): string => {
  const text = value.trim();
  if (!text || [...text].length > 2000) {
    throw new InvalidArgumentError("Description must be 1 to 2000 characters.");
  }
  return text;
};

export const integer = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
};

export const positiveInteger = (value: string): number => {
  const parsed = integer(value);
  if (parsed < 1) throw new InvalidArgumentError("Expected a positive integer.");
  return parsed;
};

export const handle = (value: string): string => {
  const normalized = value.trim().replace(/^@/u, "");
  if (!normalized || normalized.startsWith("@") || /\s/.test(normalized)) {
    throw new InvalidArgumentError(
      "Handles must be non-empty and contain no spaces.",
    );
  }
  return normalized;
};

/**
 * `--to` takes repeated flags, several words after one flag, or one
 * comma-separated list. Commander hands a variadic option's coercion each value
 * with what it kept so far, so the list has to be built here; returning one
 * handle instead leaves a string where the command expects an array.
 */
export const recipients = (value: string, previous: string[] = []): string[] =>
  [...previous, ...value.split(",").map(handle)];

export const nonempty = (name: string, value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty.`);
  return normalized;
};

export const events = (values: string[]): WebhookEventType[] => {
  if (values.length === 0) throw new Error("At least one --event is required.");
  const allowed = new Set<string>(RELAY_WEBHOOK_EVENT_TYPES);
  for (const value of values) {
    if (!allowed.has(value)) throw new Error(`Unknown Relay event type: ${value}`);
  }
  return values as WebhookEventType[];
};

export const globals = (command: Command): GlobalOptions =>
  command.optsWithGlobals<GlobalOptions>();

export const idempotencyKeyOrNew = (key: string | undefined): string =>
  key === undefined ? crypto.randomUUID() : nonempty("Idempotency key", key);

export async function readImageRecipe(path: string): Promise<AgentImageRecipe> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 8192) throw new Error("Invalid recipe file.");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Recipe too large.");
    const value: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Recipe must be an object.");
    }
    return value as AgentImageRecipe; // Server's existing recipe parser is authoritative.
  } catch {
    throw new Error("Image recipe must be a readable JSON object file no larger than 8192 bytes.");
  }
}

export const voidResult = { ok: true };

export const createCommandContext = (
  dependencies: ProgramDependencies,
): CommandContext => {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const configContext: ConfigContext = {
    ...(dependencies.configContext ?? {}),
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
  };
  const resolveClient = dependencies.resolveClient
    ?? ((profile?: string) => createClientContext(profile, configContext, dependencies.fetch));
  const output = (value: unknown): void => stdout(jsonText(value));
  // gh and vercel: a sentence for a person at a terminal, JSON for --json, a
  // pipe, or an agent (runCLI decides; tests and pipes get JSON).
  const human = (command: Command): boolean =>
    dependencies.humanOutput === true && !globals(command).json;

  // gh's "✓ Logged in to github.com account <login>": who, and the organization by name.
  const loggedIn = async (session: RelayConsoleSession): Promise<string> => {
    let organizationName: string | undefined;
    let email = session.type === "organization_key" ? undefined : session.user.email;
    try {
      const me = await consoleRequest<{ user?: { email?: string }; org?: { name?: string } }>({
        context: configContext,
        apiURL: defaultCreationApiURL(),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }, "/me");
      organizationName = me.org?.name || undefined;
      if (session.type !== "organization_key") email = me.user?.email || email;
    } catch { /* The sign-in is saved; the name is only decoration. */ }
    const organization = organizationName ? ` (${organizationName})` : "";
    return session.type === "organization_key"
      ? `\u2713 Logged in to Relay with an organization API key${organization}\n`
      : `\u2713 Logged in to Relay as ${email}${organization}\n`;
  };

  const clientFor = async (command: Command): Promise<Relay> =>
    (await resolveClient(globals(command).profile)).client;

  const usageError = (message: string, write: (value: string) => void): void => {
    if (!dependencies.json) {
      write(`${message.replace(/(?:rly_|rel_org_)[A-Za-z0-9_-]+/gu, "[REDACTED]")}${docsLine(configContext.env ?? process.env)}\n`);
    }
  };

  const agentDeps = dependencies.agents ?? agentDependencies(configContext, dependencies.fetch);
  const readStdinText = dependencies.readStdin ?? (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  });

  // The live view draws the QR code itself, so a caller that will open it must
  // not print a second copy first.
  const willShowSavedAgent = (command: Command): boolean =>
    !globals(command).json && !globals(command).nonInteractive && dependencies.isInteractive === true
      && (dependencies.terminalSession !== undefined || dependencies.terminalIO !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY));

  const showSavedAgent = async (command: Command, input: AgentSessionInput): Promise<void> => {
    if (!willShowSavedAgent(command)) return;
    try {
      await openSavedAgentSession(input, {
        agents: agentDeps,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.terminalSession ? { session: dependencies.terminalSession } : {}),
        ...(dependencies.terminalIO ? { io: dependencies.terminalIO } : {}),
        ...(dependencies.terminalClient ? { client: dependencies.terminalClient } : {}),
      });
    } catch {
      stderr("Relay could not open the live view for this agent. The agent and its token are unchanged; run the command again to retry.\n");
    }
  };

  const accessRequest = <T>(path: string, init?: RequestInit): Promise<T> =>
    dependencies.consoleRequest?.<T>(path, init) ?? consoleRequest<T>({
      context: configContext,
      apiURL: defaultCreationApiURL(),
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    }, path, init);

  // `listen` is the local half of the two ways to run an agent backend, the
  // way Stripe's `stripe listen --forward-to localhost:4242/webhook` is: each
  // event is POSTed to a route on this computer, signed exactly like a
  // deployed webhook, so the same handler runs unchanged in both places.
  const forwardEvents = async (input: ForwardEventsInput): Promise<void> => {
    const forwardTo = input.forwardTo ? validateForwardURL(input.forwardTo) : undefined;
    const secret = forwardTo ? await localWebhookSecret(input.auth.profile, configContext) : undefined;
    if (input.banner && forwardTo && secret) {
      stderr(`Forwarding events to ${link(forwardTo)}\n`);
      stderr(`Local signing secret  ${secret}   ${dim("(set RELAY_WEBHOOK_SECRET to it while you develop)")}\n`);
      stderr(`${dim("Events read here count as delivered; a deployed webhook for this agent does not get them.")}\n`);
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await listenForAgentEvents(
        input.client,
        {
          ...(forwardTo && secret ? { forwardTo, secret } : {}),
          ...(input.render ? { render: input.render } : {}),
          signal: controller.signal,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        },
        { stdout, stderr },
      );
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  };

  return {
    dependencies,
    stdout,
    stderr,
    configContext,
    resolveClient,
    output,
    human,
    loggedIn,
    clientFor,
    agentDeps,
    readStdinText,
    willShowSavedAgent,
    showSavedAgent,
    usageError,
    accessRequest,
    forwardEvents,
  };
};
