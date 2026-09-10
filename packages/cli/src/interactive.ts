import { confirm, intro, isCancel, log, outro, password, select, spinner, text } from "@clack/prompts";
import type { AgentDependencies } from "./agents.js";
import { listAgents } from "./agents.js";
import { DEFAULT_API_URL, DEFAULT_PROFILE, defaultCreationApiURL, validateApiURL } from "./config.js";

export class InteractiveCancelled extends Error {
  constructor() { super("Cancelled."); }
}
/**
 * There is no terminal, so a question cannot be asked. Every one of these names
 * the flags that would have answered it, and the command exits 2 (Stripe's and
 * eas's shape: say the next step, never print a usage block).
 */
export class HeadlessPrompt extends Error {
  constructor(message: string, readonly flags: readonly string[]) { super(message); }
  get nextStep(): string { return this.flags.join("  ·  "); }
}
export interface InteractiveSpinner {
  start(message: string): void;
  stop(message: string): void;
}
export interface InteractivePrompts {
  select(message: string, options: Array<{ value: string; label: string }>): Promise<string>;
  confirm(message: string): Promise<boolean>;
  password(message: string): Promise<string>;
  text(message: string, initialValue: string): Promise<string>;
  info(message: string): void;
  /** The opening and closing bars of one Clack session. */
  intro(message: string): void;
  outro(message: string): void;
  /** A finished step: the same diamond the prompts leave behind. */
  step(message: string): void;
  spinner(): InteractiveSpinner;
}
function answer<T>(value: T | symbol): T {
  if (isCancel(value)) throw new InteractiveCancelled();
  return value as T;
}
export function clackPrompts(info: (message: string) => void): InteractivePrompts {
  const io = { input: process.stdin, output: process.stderr };
  return {
    select: async (message, options) => answer(await select({ message, options, ...io })),
    confirm: async (message) => answer(await confirm({ message, initialValue: false, ...io })),
    password: async (message) => answer(await password({ message, ...io })),
    text: async (message, initialValue) => answer(await text({ message, initialValue, ...io })),
    info,
    intro: (message) => intro(message),
    outro: (message) => outro(message),
    step: (message) => log.step(message),
    spinner: () => {
      const active = spinner({ output: process.stderr });
      return { start: (message) => active.start(message), stop: (message) => active.stop(message) };
    },
  };
}
// Source-backed CI/TTY conditions: Photon cli/src/lib/tty.ts. Unlike its
// destructive helper, non-TTY Relay commands do NOT gain a mandatory --yes.
export function interactiveAllowed(argv: readonly string[], env: NodeJS.ProcessEnv, tty: boolean): boolean {
  return tty && !["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "BUILDKITE", "TF_BUILD"].some((key) => Boolean(env[key]))
    && !argv.some((arg) => ["--non-interactive", "--json", "--help", "-h", "--version", "-V"].includes(arg));
}
export type InteractiveEntry = "root" | "agents" | "auth";
export function interactiveEntry(argv: readonly string[]): { entry: InteractiveEntry; prefix: string[] } | undefined {
  const rest: string[] = []; const prefix: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--profile" && argv[index + 1]) { prefix.push(arg, argv[++index]!); }
    else if (arg.startsWith("--profile=")) prefix.push(arg);
    else if (arg !== "--non-interactive" && arg !== "--json") rest.push(arg);
  }
  if (!rest.length) return { entry: "root", prefix };
  if (rest.length === 1 && (rest[0] === "agents" || rest[0] === "auth")) return { entry: rest[0], prefix };
  return undefined;
}
export async function chooseInteractiveCommand(
  entry: InteractiveEntry, prefix: string[], deps: AgentDependencies, ui: InteractivePrompts,
  beforeSetup: () => Promise<void> = async () => undefined,
): Promise<string[] | "install-skill" | undefined> {
  const options = entry === "auth" ? [
    { value: "login", label: "Sign in with a token you already have" },
    { value: "status", label: "Show which token this computer uses" },
    { value: "logout", label: "Remove the saved token from this computer" },
    { value: "exit", label: "Exit" },
  ] : [
    { value: "create", label: "Create agent" },
    ...(entry === "root" ? [{ value: "login", label: "Sign in with an existing token" }] : []),
    { value: "list", label: "List saved agents" },
    { value: "delete", label: "Delete agent" },
    ...(entry === "root" ? [{ value: "skill", label: "Install Relay skill" }] : []),
    { value: "exit", label: "Exit" },
  ];
  const action = await ui.select("Relay — what would you like to do?", options);
  if (action === "exit") return undefined;
  if (action === "skill") return "install-skill";
  if (action === "create") {
    await beforeSetup();
    ui.info("Press Enter to skip any of these. Relay picks a handle for you if you skip it. A picture can be a file on this computer or an https:// address.");
    const chosenHandle = (await ui.text("Handle (optional)", "")).trim();
    const displayName = (await ui.text("Name (optional)", "")).trim();
    const image = (await ui.text("Image (optional)", "")).trim();
    return [...prefix, "agents", "create",
      ...(chosenHandle ? ["--handle", chosenHandle] : []),
      ...(displayName ? ["--name", displayName] : []),
      ...(image ? ["--image", image] : []),
    ];
  }
  if (action === "login") {
    await beforeSetup();
    const config = await deps.read();
    const profileArg = prefix.find((value) => value.startsWith("--profile="))?.slice(10) ?? (prefix[0] === "--profile" ? prefix[1] : undefined);
    const selectedName = profileArg ?? deps.env.RELAY_PROFILE ?? config.current_profile;
    const saved = config.profiles[selectedName];
    const legacyEmptyDefault = selectedName === DEFAULT_PROFILE && !saved?.agent_token
      && saved?.api_url === DEFAULT_API_URL && !profileArg && !deps.env.RELAY_PROFILE;
    const initial = validateApiURL(deps.env.RELAY_API_URL ?? (!legacyEmptyDefault ? saved?.api_url : undefined) ?? defaultCreationApiURL());
    const origin = validateApiURL(await ui.text("Relay API address", initial));
    return [...prefix, "auth", "login", "--api-url", origin];
  }
  if (action === "status" || action === "logout") return [...prefix, "auth", action];
  if (action === "list") return [...prefix, "agents", "list"];
  if (action === "delete") {
    const inventory = await listAgents(deps);
    const choices = inventory.agents.flatMap((row) => "handle" in row
      ? [{ profile: row.profile, handle: row.handle, label: `@${row.handle} · profile ${row.profile} · ${row.api_url}` }]
      : []);
    if (!choices.length) { ui.info("No saved agents."); return undefined; }
    const selected = await ui.select("Select the agent to delete", choices.map((choice, index) => ({ value: String(index), label: choice.label })));
    const choice = choices[Number(selected)];
    if (!choice) throw new InteractiveCancelled();
    // Choosing here removes any doubt about which profile is meant; the delete
    // command and its confirmation still do the deleting and the token cleanup.
    return ["--profile", choice.profile, "agents", "delete", choice.handle];
  }
  throw new InteractiveCancelled();
}
