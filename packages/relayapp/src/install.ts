/**
 * `relayapp install-codex` / `relayapp install-claude`.
 *
 * install-codex merges — never clobbers — three things into the user's Codex
 * setup:
 *   ~/.codex/config.toml  [mcp_servers.relay]  → `relayapp mcp` stdio server
 *   ~/.codex/config.toml  notify               → `relayapp notify` turn-complete ping
 *   ~/.codex/hooks.json   PermissionRequest    → `relayapp hook permission-request`
 *                                                (phone-tap approvals; Codex hooks
 *                                                answer with decision JSON on stdout)
 *
 * Existing user values are preserved: a different notify command or an
 * existing hook list is left alone (we append/skip, and report what we did).
 */
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
  CodexNotifyPolicyStore,
  ConfigStore,
  resolveOwnerUserId,
  runtimeHomeForConfig,
} from "./store.js";

export interface MergeReport {
  changed: boolean;
  notes: string[];
}

export interface InstallCodexOptions {
  projectRoot?: string;
  policy?: CodexNotifyPolicyStore;
}

const RELAY_NOTIFY = ["relayapp", "notify"];
const RELAY_PERMISSION_HOOK_COMMAND = "relayapp hook permission-request";
// Codex's hooks engine is Claude-style: matcher groups wrapping command handlers.
const RELAY_PERMISSION_HOOK_ENTRY = {
  matcher: "*",
  hooks: [{ type: "command", command: RELAY_PERMISSION_HOOK_COMMAND }],
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Secret-bearing Codex config writes are private and crash-atomic. */
export function writePrivateText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  let fd = openSync(tmp, "wx", 0o600);
  let installed = false;
  try {
    writeSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    installed = true;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (!installed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best effort cleanup; preserve the original failure.
      }
    }
  }
}

/**
 * Pure merge for tests: returns the new TOML text plus a report.
 *
 * The existing file is parsed only to DETECT what is present; the returned
 * text is the user's original byte-for-byte with the missing pieces added
 * textually (top-level `notify` prepended before the first table so it stays
 * top-level; `[mcp_servers.relay]` appended at the end). Comments, ordering,
 * and formatting the user wrote are never round-tripped away.
 */
export function mergeCodexConfigToml(existing: string): { toml: string; report: MergeReport } {
  const notes: string[] = [];
  let changed = false;
  let doc: Record<string, unknown>;
  try {
    doc = (existing.trim().length > 0 ? parseToml(existing) : {}) as Record<string, unknown>;
  } catch {
    throw new Error("~/.codex/config.toml exists but is not valid TOML; not touching it");
  }

  let toml = existing;
  const servers = doc.mcp_servers as Record<string, unknown> | undefined;
  if (servers?.relay === undefined) {
    const suffix = `[mcp_servers.relay]\ncommand = "relayapp"\nargs = ["mcp"]\n`;
    toml = toml.length === 0 || toml.endsWith("\n\n") ? `${toml}${suffix}`
      : toml.endsWith("\n") ? `${toml}\n${suffix}`
      : `${toml}\n\n${suffix}`;
    notes.push("added [mcp_servers.relay]");
    changed = true;
  } else {
    notes.push("kept existing [mcp_servers.relay]");
  }

  if (doc.notify === undefined) {
    // Top-level keys must precede any [table]; prepending is always valid.
    toml = `notify = ["relayapp", "notify"]\n${toml.length > 0 && !toml.startsWith("\n") ? "\n" : ""}${toml}`;
    notes.push('set notify = ["relayapp", "notify"]');
    changed = true;
  } else if (JSON.stringify(doc.notify) === JSON.stringify(RELAY_NOTIFY)) {
    notes.push("notify already points at relayapp");
  } else {
    notes.push(
      `left existing notify unchanged (${JSON.stringify(doc.notify)}); ` +
        "chain relayapp notify from your own script if you want both",
    );
  }

  // Sanity: never write a file Codex cannot parse.
  parseToml(toml);
  return { toml, report: { changed, notes } };
}

/** Pure merge for tests: hooks.json PermissionRequest handler, append-only. */
export function mergeHooksJson(existing: string): { json: string; report: MergeReport } {
  const notes: string[] = [];
  let changed = false;
  let doc: Record<string, unknown>;
  try {
    doc = existing.trim().length > 0 ? JSON.parse(existing) : {};
  } catch {
    throw new Error("~/.codex/hooks.json exists but is not valid JSON; not touching it");
  }
  const hooks = (doc.hooks ??= {}) as Record<string, unknown>;
  const list = (hooks.PermissionRequest ??= []) as unknown[];
  if (!Array.isArray(list)) {
    throw new Error("hooks.PermissionRequest is not an array; not touching it");
  }
  const already = JSON.stringify(list).includes(RELAY_PERMISSION_HOOK_COMMAND);
  if (already) {
    notes.push("PermissionRequest hook already installed");
  } else {
    list.push(RELAY_PERMISSION_HOOK_ENTRY);
    notes.push("appended relayapp PermissionRequest hook");
    changed = true;
  }
  return { json: `${JSON.stringify(doc, null, 2)}\n`, report: { changed, notes } };
}

function currentProjectRoot(cwd = process.cwd()): string {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return git.status === 0 && git.stdout.trim().length > 0 ? git.stdout.trim() : cwd;
}

export function installCodex(
  codexHome = join(homedir(), ".codex"),
  out: (line: string) => void = console.log,
  options: InstallCodexOptions = {},
): void {
  mkdirSync(codexHome, { recursive: true });

  const allowedRoot = (options.policy ?? new CodexNotifyPolicyStore()).allowProject(
    options.projectRoot ?? currentProjectRoot(),
  );

  const configPath = join(codexHome, "config.toml");
  const existingToml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const merged = mergeCodexConfigToml(existingToml);
  if (merged.report.changed) {
    // Keep a copy of the pristine original before our first modification.
    if (existingToml.length > 0 && !existsSync(`${configPath}.bak`)) {
      writePrivateText(`${configPath}.bak`, existingToml);
      merged.report.notes.push(`original saved to ${configPath}.bak`);
    }
    writePrivateText(configPath, merged.toml);
  }
  out(`${configPath}:`);
  for (const note of merged.report.notes) out(`  - ${note}`);

  const hooksPath = join(codexHome, "hooks.json");
  const existingHooks = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
  const hooks = mergeHooksJson(existingHooks);
  if (hooks.report.changed) {
    if (existingHooks.length > 0 && !existsSync(`${hooksPath}.bak`)) {
      writePrivateText(`${hooksPath}.bak`, existingHooks);
      hooks.report.notes.push(`original saved to ${hooksPath}.bak`);
    }
    writePrivateText(hooksPath, hooks.json);
  }
  out(`${hooksPath}:`);
  for (const note of hooks.report.notes) out(`  - ${note}`);

  const finalConfig = parseToml(merged.toml) as Record<string, any>;
  const relayMcp = finalConfig.mcp_servers?.relay;
  const mcpActive = relayMcp?.command === "relayapp" &&
    JSON.stringify(relayMcp?.args) === JSON.stringify(["mcp"]);
  const notifyActive = JSON.stringify(finalConfig.notify) === JSON.stringify(RELAY_NOTIFY);
  const finalHooks = JSON.parse(hooks.json) as Record<string, unknown>;
  const permissionActive = JSON.stringify(finalHooks).includes(RELAY_PERMISSION_HOOK_COMMAND);
  out("");
  out(`Relay enabled only for this project root: ${allowedRoot}`);
  if (mcpActive && notifyActive && permissionActive) {
    out("Codex will send the final assistant message when a turn completes and route tool");
    out("approvals to your phone only from that project.");
  } else {
    out("Relay Codex setup is partial because existing non-Relay values were preserved:");
    out(`  - MCP relay_send_message: ${mcpActive ? "active" : "inactive (existing mcp_servers.relay kept)"}`);
    out(`  - final-message notify: ${notifyActive ? "active" : "inactive (existing notify kept)"}`);
    out(`  - phone permission hook: ${permissionActive ? "active" : "inactive"}`);
  }
  out("Codex gates untrusted hook handlers: the first run may ask you to trust the relayapp handler.");
  out("Approvals require `relayapp pair` to have run on this machine.");
  out("Run install-codex separately inside each additional project you explicitly opt in.");
}

export interface InstallClaudeOptions {
  config?: ConfigStore;
  channelDir?: string;
  /** Generated marketplace root; injectable only for tests. */
  bundleDir?: string;
  /** Stable account-scoped install root; injectable only for tests. */
  installRoot?: string;
  claudeCommand?: string;
  runClaude?: (command: string, args: string[]) => {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
}

export interface InstallOpenClawOptions {
  config?: ConfigStore;
  openclawHome?: string;
  bundleDir?: string;
  installRoot?: string;
  openclawCommand?: string;
  runOpenClaw?: InstallClaudeOptions["runClaude"];
}

function parseEnvValues(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

export function mergeClaudeChannelEnv(
  existing: string,
  desired: { token: string; origin: string; ownerUserId: string },
): string {
  const values = parseEnvValues(existing);
  const required: Record<string, string> = {
    RELAY_AGENT_TOKEN: desired.token,
    RELAY_BASE_URL: desired.origin,
    RELAY_OWNER_USER_ID: desired.ownerUserId,
  };
  for (const [key, value] of Object.entries(required)) {
    if (/[\r\n]/u.test(value)) throw new Error(`Refusing newline in ${key}`);
    if (values[key] && values[key] !== value) {
      throw new Error(
        `Claude Relay channel already has a different ${key}. ` +
          "Its .env was not changed; move it aside deliberately before installing this paired agent.",
      );
    }
  }
  const missing = Object.entries(required).filter(([key]) => values[key] !== required[key]);
  if (missing.length === 0) return existing;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${prefix}${missing.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function runExternalCommand(
  product: string,
  command: string,
  args: string[],
  stage: string,
  runner: NonNullable<InstallClaudeOptions["runClaude"]>,
): ReturnType<NonNullable<InstallClaudeOptions["runClaude"]>> {
  const result = runner(command, args);
  if (result.status === 0) return result;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  const suffix = detail.length > 0 ? `: ${detail}` : result.error ? `: ${result.error.message}` : "";
  throw new Error(`${product} ${stage} failed${suffix}`);
}

export function platformCliCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || /\.(?:bat|cmd|com|exe)$/iu.test(command)) return command;
  return `${command}.cmd`;
}

function resolveOpenClawConfigPath(
  command: string,
  runner: NonNullable<InstallClaudeOptions["runClaude"]>,
): string {
  const result = runExternalCommand(
    "OpenClaw",
    command,
    ["config", "file"],
    "config path lookup",
    runner,
  );
  const lines = (result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const reported = lines.at(-1) ?? "";
  if (!reported || /[\0\r\n]/u.test(reported)) {
    throw new Error("OpenClaw config path lookup returned no usable path");
  }
  if (/^~[\\/]/u.test(reported)) return join(homedir(), reported.slice(2));
  return isAbsolute(reported) ? reported : resolve(reported);
}

function makeTreePrivate(path: string): void {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeTreePrivate(join(path, name));
}

function persistClaudeMarketplace(source: string, installRoot: string): string {
  const digest = createHash("sha256");
  const visit = (path: string, relative = "") => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const child = relative ? `${relative}/${name}` : name;
      if (statSync(absolute).isDirectory()) visit(absolute, child);
      else {
        digest.update(child).update("\0").update(readFileSync(absolute)).update("\0");
      }
    }
  };
  visit(source);
  const destination = join(installRoot, digest.digest("hex").slice(0, 24), "marketplace");
  if (existsSync(destination)) return destination;
  mkdirSync(dirname(dirname(destination)), { recursive: true, mode: 0o700 });
  const temporary = `${dirname(destination)}.tmp-${process.pid}-${Date.now()}`;
  try {
    cpSync(source, join(temporary, "marketplace"), { recursive: true, errorOnExist: true });
    makeTreePrivate(temporary);
    renameSync(temporary, dirname(destination));
  } catch (error: any) {
    rmSync(temporary, { recursive: true, force: true });
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
  }
  if (!existsSync(destination)) throw new Error("Could not persist the bundled Claude marketplace");
  return destination;
}

function persistOpenClawArchive(source: string, installRoot: string): string {
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 24);
  const destination = join(installRoot, digest, "relay-openclaw-plugin.tgz");
  if (existsSync(destination)) return destination;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    cpSync(source, temporary, { errorOnExist: true });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenClaw config ${key} must be an object; not touching it`);
  }
  return value as Record<string, unknown>;
}

export function mergeOpenClawConfig(
  existing: string,
  desired: { token: string; tokenFile: string; baseUrl: string },
): string {
  let doc: Record<string, unknown>;
  try {
    doc = existing.trim() ? JSON.parse(existing) : {};
  } catch {
    throw new Error("~/.openclaw/openclaw.json exists but is not valid JSON; not touching it");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("~/.openclaw/openclaw.json root must be an object; not touching it");
  }
  const plugins = objectAt(doc, "plugins");
  const allow = plugins.allow ?? [];
  if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === "string")) {
    throw new Error("OpenClaw config plugins.allow must be a string array; not touching it");
  }
  if (!allow.includes("relay")) allow.push("relay");
  plugins.allow = allow;
  const entries = objectAt(plugins, "entries");
  objectAt(entries, "relay").enabled = true;

  const channels = objectAt(doc, "channels");
  const relay = objectAt(channels, "relay");
  if (typeof relay.token === "string" && relay.token !== desired.token) {
    throw new Error("OpenClaw Relay channel already has a different token; not touching it");
  }
  if (typeof relay.tokenFile === "string" && relay.tokenFile !== desired.tokenFile) {
    throw new Error("OpenClaw Relay channel already has a different tokenFile; not touching it");
  }
  if (typeof relay.baseUrl === "string" && new URL(relay.baseUrl).origin !== new URL(desired.baseUrl).origin) {
    throw new Error("OpenClaw Relay channel already has a different baseUrl; not touching it");
  }
  relay.enabled = true;
  relay.tokenFile = desired.tokenFile;
  relay.baseUrl = desired.baseUrl;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Install the bundled marketplace plus owner-only channel credentials. */
export function installClaude(
  out: (line: string) => void = console.log,
  options: InstallClaudeOptions = {},
): void {
  const config = options.config ?? new ConfigStore();
  const paired = config.load();
  if (!paired?.agent_token) throw new Error("Not paired. Run `relayapp pair` first.");
  const ownerUserId = resolveOwnerUserId(paired);
  const channelDir = options.channelDir ?? join(homedir(), ".claude", "channels", "relay");
  const envPath = join(channelDir, ".env");
  const existingEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const mergedEnv = mergeClaudeChannelEnv(existingEnv, {
    token: paired.agent_token,
    origin: paired.api_origin,
    ownerUserId,
  });

  const bundledMarketplace = options.bundleDir ?? join(MODULE_DIR, "..", "claude-plugin", "marketplace");
  const pluginDir = join(bundledMarketplace, "plugins", "relay");
  for (const relative of [
    ".claude-plugin/plugin.json",
    "commands/configure.md",
    "runtime/server.mjs",
    "LICENSE",
    "README.md",
  ]) {
    if (!existsSync(join(pluginDir, relative))) {
      throw new Error(`Installed relayapp package is missing bundled Claude plugin file: ${relative}`);
    }
  }
  if (!existsSync(join(bundledMarketplace, ".claude-plugin", "marketplace.json"))) {
    throw new Error("Installed relayapp package is missing its bundled Claude marketplace manifest");
  }

  const command = options.claudeCommand ?? process.env.RELAYAPP_CLAUDE_BIN?.trim() ?? "claude";
  const runner = options.runClaude ?? ((binary, args) => {
    const result = spawnSync(platformCliCommand(binary), args, {
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  });
  // Validate what will actually be installed, then add the local marketplace.
  // `marketplace add` and `plugin install` are idempotent in Claude Code and
  // update a moved npm package path without needing GitHub access.
  runExternalCommand("Claude Code", command, ["plugin", "validate", pluginDir, "--strict"], "plugin validation", runner);
  runExternalCommand(
    "Claude Code",
    command,
    ["plugin", "validate", bundledMarketplace, "--strict"],
    "marketplace validation",
    runner,
  );
  const marketplaceDir = persistClaudeMarketplace(
    bundledMarketplace,
    options.installRoot ?? join(runtimeHomeForConfig(paired, dirname(config.path)), "installed-plugins", "claude"),
  );
  runExternalCommand(
    "Claude Code",
    command,
    ["plugin", "validate", join(marketplaceDir, "plugins", "relay"), "--strict"],
    "persisted plugin validation",
    runner,
  );
  runExternalCommand(
    "Claude Code",
    command,
    ["plugin", "marketplace", "add", marketplaceDir],
    "local marketplace installation",
    runner,
  );
  runExternalCommand(
    "Claude Code",
    command,
    ["plugin", "install", "relay@relayapp-bundled", "--scope", "user"],
    "plugin installation",
    runner,
  );

  if (mergedEnv !== existingEnv) {
    if (existingEnv.length > 0 && !existsSync(`${envPath}.bak`)) {
      writePrivateText(`${envPath}.bak`, existingEnv);
    }
    writePrivateText(envPath, mergedEnv);
  } else if (existsSync(envPath)) {
    chmodSync(envPath, 0o600);
  }
  out(`Configured Claude Relay channel at ${envPath} (mode 600).`);
  out(`API origin: ${paired.api_origin}; owner pin: ${ownerUserId}. Agent Token was not printed.`);
  out(`Installed bundled Claude plugin relay@relayapp-bundled from ${marketplaceDir}.`);
  out("");
  out("Run:");
  out("  claude --dangerously-load-development-channels plugin:relay@relayapp-bundled");
  out("Setup guide: https://docs.relayapp.im/guides/coding-agents");
}

/** Install and configure the OpenClaw plugin from relayapp's bundled archive. */
export function installOpenClaw(
  out: (line: string) => void = console.log,
  options: InstallOpenClawOptions = {},
): void {
  const config = options.config ?? new ConfigStore();
  const paired = config.load();
  if (!paired?.agent_token) throw new Error("Not paired. Run `relayapp pair` first.");
  if (/[\r\n]/u.test(paired.agent_token)) throw new Error("Refusing newline in Agent Token");
  const openclawHome = options.openclawHome ?? join(homedir(), ".openclaw");
  const command = options.openclawCommand ?? process.env.RELAYAPP_OPENCLAW_BIN?.trim() ?? "openclaw";
  const runner = options.runOpenClaw ?? ((binary, args) => {
    const result = spawnSync(platformCliCommand(binary), args, {
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  });
  // OpenClaw can relocate its config via environment/state settings. Ask its
  // own CLI for the authoritative path instead of assuming ~/.openclaw.
  const configPath = resolveOpenClawConfigPath(command, runner);
  const tokenPath = join(openclawHome, "secrets", "relay-agent-token");
  const existingToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
  if (existingToken && existingToken !== paired.agent_token) {
    throw new Error("OpenClaw Relay token file contains a different paired identity; not touching it");
  }
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const desired = {
    token: paired.agent_token,
    tokenFile: tokenPath,
    baseUrl: paired.api_origin,
  };
  // Identity conflicts must fail before the official installer changes any
  // external state. This first merge is validation-only.
  mergeOpenClawConfig(existingConfig, desired);

  const bundleDir = options.bundleDir ?? join(MODULE_DIR, "..", "openclaw-plugin");
  const archives = readdirSync(bundleDir).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Installed relayapp package must contain exactly one OpenClaw archive; found ${archives.length}`);
  }
  const archive = persistOpenClawArchive(
    join(bundleDir, archives[0]!),
    options.installRoot ?? join(runtimeHomeForConfig(paired, dirname(config.path)), "installed-plugins", "openclaw"),
  );
  runExternalCommand("OpenClaw", command, ["plugins", "install", archive, "--force"], "plugin installation", runner);

  // The official installer stamps root metadata and records install
  // provenance/update/uninstall state. Re-read after it returns; a merge
  // computed before that command would overwrite the newly authoritative
  // state. Apply only Relay's fields through OpenClaw's config writer so the
  // resulting write is validated and freshly stamped by OpenClaw itself.
  const installedConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const mergedConfig = JSON.parse(mergeOpenClawConfig(installedConfig, desired)) as Record<string, any>;
  const configUpdates = [
    { path: "plugins.allow", value: mergedConfig.plugins.allow },
    { path: "plugins.entries.relay.enabled", value: true },
    { path: "channels.relay.enabled", value: true },
    { path: "channels.relay.tokenFile", value: tokenPath },
    { path: "channels.relay.baseUrl", value: paired.api_origin },
  ];
  writePrivateText(tokenPath, `${paired.agent_token}\n`);
  runExternalCommand(
    "OpenClaw",
    command,
    ["config", "set", "--batch-json", JSON.stringify(configUpdates)],
    "Relay config merge",
    runner,
  );
  if (existsSync(configPath)) chmodSync(configPath, 0o600);
  out(`Installed bundled Relay plugin into OpenClaw from ${archive}.`);
  out(`Configured ${configPath} and owner-private token file ${tokenPath}. Agent Token was not printed.`);
  out("Restart the OpenClaw gateway to activate Relay.");
}
