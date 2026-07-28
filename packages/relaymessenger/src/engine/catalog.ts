/**
 * ACP runtime presets supported by relaymessenger.
 *
 * Bundled adapters are exact npm dependencies resolved by acp.ts. External
 * runtimes are always user-installed binaries: relaymessenger never downloads a
 * mutable CLI at startup and never passes a command through a shell.
 */

export const ENGINE_NAMES = [
  "claude",
  "codex",
  "hermes",
] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

export interface ExternalEngineSpec {
  displayName: string;
  command: string;
  args: string[];
  versionArgs: string[];
  docsUrl: string;
  /** Runtime-specific readiness check that does not reveal credentials. */
  checkArgs?: string[];
  /** Some ACP servers impose a shorter requestPermission deadline. */
  permissionTimeoutMs?: number;
}

export const EXTERNAL_ENGINE_SPECS: Record<Exclude<EngineName, "claude" | "codex">, ExternalEngineSpec> = {
  hermes: {
    displayName: "Hermes Agent",
    command: "hermes",
    args: ["acp"],
    versionArgs: ["--version"],
    checkArgs: ["acp", "--check"],
    docsUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp",
    // Hermes currently waits 60 seconds for an ACP permission decision.
    permissionTimeoutMs: 55_000,
  },
};

export function isEngineName(value: unknown): value is EngineName {
  return typeof value === "string" && (ENGINE_NAMES as readonly string[]).includes(value);
}

export function engineDisplayName(engine: EngineName | string): string {
  if (engine === "claude") return "Claude Code";
  if (engine === "codex") return "Codex";
  return EXTERNAL_ENGINE_SPECS[engine as keyof typeof EXTERNAL_ENGINE_SPECS]?.displayName ?? engine;
}

export function enginePermissionTimeoutMs(engine: EngineName): number | undefined {
  if (engine === "claude" || engine === "codex") return undefined;
  return EXTERNAL_ENGINE_SPECS[engine].permissionTimeoutMs;
}

export const ENGINE_HELP = ENGINE_NAMES.join("|");
