import { confirm, intro, isCancel, log, multiselect, note, outro, password, select, spinner, text } from "@clack/prompts";
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
  constructor(message: string, readonly flags: readonly string[], private readonly step?: string) { super(message); }
  /** The one thing to run next: the flags, or the sentence a caller gave instead. */
  get nextStep(): string { return this.step ?? this.flags.join("  ·  "); }
}
export interface InteractiveSpinner {
  start(message: string): void;
  stop(message: string): void;
}
export interface InteractivePrompts {
  select(message: string, options: Array<{ value: string; label: string }>): Promise<string>;
  /** Several boxes, some ticked before the person touches them. */
  multiselect(message: string, options: Array<{ value: string; label: string }>, initialValues: string[]): Promise<string[]>;
  confirm(message: string, options?: { initialValue?: boolean }): Promise<boolean>;
  password(message: string): Promise<string>;
  text(message: string, initialValue: string): Promise<string>;
  info(message: string): void;
  /** The opening and closing bars of one Clack session. */
  intro(message: string): void;
  outro(message: string): void;
  /** A finished step: the same diamond the prompts leave behind. */
  step(message: string): void;
  /** A step that went well. */
  success(message: string): void;
  /** A sentence inside the gutter that is neither a question nor a step. */
  message(message: string): void;
  /** A titled block, drawn as one box inside the gutter (Clack's own example
   * ends with `p.note(nextSteps, 'Next steps.')`, examples/basic/index.ts:88). */
  note(message: string, title: string): void;
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
    multiselect: async (message, options, initialValues) => answer(await multiselect({ message, options, initialValues, required: false, ...io })),
    confirm: async (message, options) => answer(await confirm({ message, initialValue: options?.initialValue ?? false, ...io })),
    password: async (message) => answer(await password({ message, ...io })),
    text: async (message, initialValue) => answer(await text({ message, initialValue, ...io })),
    info,
    intro: (message) => intro(message),
    outro: (message) => outro(message),
    step: (message) => log.step(message),
    success: (message) => log.success(message),
    message: (message) => log.message(message),
    note: (message, title) => note(message, title),
    spinner: () => {
      const active = spinner({ output: process.stderr });
      return { start: (message) => active.start(message), stop: (message) => active.stop(message) };
    },
  };
}
/**
 * The terminal and the flags decide, and nothing else. All 27 command-line tools
 * measured on 2026-09-09 ignore `CI` and its relatives and key on whether stdin
 * is a terminal, so a person on a machine that happens to export `CI` still gets
 * the menus, and a script that owns a terminal still gets none when it says so.
 */
export function interactiveAllowed(argv: readonly string[], tty: boolean): boolean {
  // `--no-input` is clig.dev's name for the flag ("If --no-input is passed,
  // don't prompt or do anything interactive"); `--non-interactive` is Vercel's
  // and eas's, kept as the same flag (ledger rows P21 and P27).
  return tty && !argv.some((arg) => ["--non-interactive", "--no-input", "--json", "--help", "-h", "--version", "-V"].includes(arg));
}
/** Named the flag, in either spelling. */
export const nonInteractiveRequested = (argv: readonly string[]): boolean =>
  argv.includes("--non-interactive") || argv.includes("--no-input");
export type InteractiveEntry = "root" | "agents" | "auth";
export function interactiveEntry(argv: readonly string[]): { entry: InteractiveEntry; prefix: string[] } | undefined {
  const rest: string[] = []; const prefix: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--profile" && argv[index + 1]) { prefix.push(arg, argv[++index]!); }
    else if (arg.startsWith("--profile=")) prefix.push(arg);
    else if (arg === "--agent" && argv[index + 1]) { prefix.push(arg, argv[++index]!); }
    else if (arg.startsWith("--agent=")) prefix.push(arg);
    else if (!["--non-interactive", "--no-input", "--json", "-q", "--quiet", "--verbose"].includes(arg)) rest.push(arg);
  }
  if (!rest.length) return { entry: "root", prefix };
  if (rest.length === 1 && (rest[0] === "agents" || rest[0] === "auth")) return { entry: rest[0], prefix };
  return undefined;
}
export async function chooseInteractiveCommand(
  entry: InteractiveEntry, prefix: string[], deps: AgentDependencies, ui: InteractivePrompts,
): Promise<string[] | "install-skill" | undefined> {
  // The door names what a person wants, not what Relay does. Creating an agent
  // and pasting a token both live inside Connect, and only when they are needed.
  const options = entry === "root" ? [
    { value: "connect", label: "Connect an agent" },
    { value: "watch", label: "Watch an agent" },
    { value: "exit", label: "Exit" },
  ] : entry === "auth" ? [
    { value: "login", label: "Sign in with a token you already have" },
    { value: "status", label: "Show which token this computer uses" },
    { value: "logout", label: "Remove the saved token from this computer" },
    { value: "exit", label: "Exit" },
  ] : [
    { value: "create", label: "Create agent" },
    { value: "list", label: "List saved agents" },
    { value: "delete", label: "Delete agent" },
    { value: "exit", label: "Exit" },
  ];
  const action = await ui.select(entry === "root" ? "What would you like to do?" : "Relay — what would you like to do?", options);
  if (action === "exit") return undefined;
  if (action === "connect") return [...prefix, "connect"];
  if (action === "watch") {
    const chosen = await chooseSavedAgent("Select the agent to watch", deps, ui);
    return chosen ? ["--profile", chosen.profile, "watch", chosen.handle] : undefined;
  }
  if (action === "create") {
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
    // Choosing here removes any doubt about which profile is meant; the delete
    // command and its confirmation still do the deleting and the token cleanup.
    const chosen = await chooseSavedAgent("Select the agent to delete", deps, ui);
    return chosen ? ["--profile", chosen.profile, "agents", "delete", chosen.handle] : undefined;
  }
  throw new InteractiveCancelled();
}

async function chooseSavedAgent(
  message: string, deps: AgentDependencies, ui: InteractivePrompts,
): Promise<{ profile: string; handle: string } | undefined> {
  const inventory = await listAgents(deps);
  const choices = inventory.agents.flatMap((row) => "handle" in row
    ? [{ profile: row.profile, handle: row.handle, label: `@${row.handle} · profile ${row.profile} · ${row.api_url}` }]
    : []);
  if (!choices.length) { ui.info("No saved agents."); return undefined; }
  const selected = await ui.select(message, choices.map((choice, index) => ({ value: String(index), label: choice.label })));
  const choice = choices[Number(selected)];
  if (!choice) throw new InteractiveCancelled();
  return { profile: choice.profile, handle: choice.handle };
}
