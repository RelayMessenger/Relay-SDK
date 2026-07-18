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
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export interface MergeReport {
  changed: boolean;
  notes: string[];
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

export function installCodex(codexHome = join(homedir(), ".codex"), out: (line: string) => void = console.log): void {
  mkdirSync(codexHome, { recursive: true });

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

  out("");
  out("Codex will now ping Relay when a turn completes (notify) and route tool");
  out("approvals to your phone (PermissionRequest hook). Codex gates untrusted");
  out("hook handlers: the first run may ask you to trust the relayapp handler.");
  out("Approvals require `relayapp pair` to have run on this machine.");
}

/**
 * install-claude: the repository is a Claude plugin marketplace. Print the
 * same install/run identity whether this command runs from a source checkout
 * or the published CLI package.
 */
export function installClaude(out: (line: string) => void = console.log, searchFrom = MODULE_DIR): void {
  let dir = searchFrom;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "integrations", "claude-code");
    if (existsSync(candidate)) {
      out(`Source checkout plugin: ${candidate}`);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out("In Claude Code, install Relay from its marketplace:");
  out("  /plugin marketplace add companion-inc/relayapp");
  out("  /plugin install relay@relayapp");
  out("");
  out("Then run:");
  out("  claude --dangerously-load-development-channels plugin:relay@relayapp");
  out("Setup guide: https://docs.relayapp.im/guides/coding-agents");
}
