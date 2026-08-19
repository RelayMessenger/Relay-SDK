/** `relaymessenger doctor` — environment and pairing health checks. */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import crossSpawn from "cross-spawn";
import { resolveApiOrigin, RelayClient } from "./api.js";
import { claudeBypassWarning } from "./claude-settings.js";
import { ADAPTER_PACKAGES, ADAPTER_VERSIONS, adapterEntrypoint } from "./engine/acp.js";
import { EXTERNAL_ENGINE_SPECS } from "./engine/catalog.js";
import {
  ApprovalStore,
  ConfigStore,
  readStateSnapshot,
  runtimeHomeForConfig,
} from "./store.js";

export async function doctor(out: (line: string) => void = console.log): Promise<boolean> {
  let healthy = true;
  const check = (ok: boolean, label: string, detail?: string) => {
    healthy = healthy && ok;
    out(`${ok ? "ok " : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
    return ok;
  };

  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  check(
    (nodeMajor ?? 0) > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 18),
    "node >= 22.18",
    `running ${process.versions.node}`,
  );

  const config = new ConfigStore();
  const loaded = config.load();
  if (check(Boolean(loaded?.agent_token), "paired (config.json has agent_token)", config.path)) {
    if (process.platform !== "win32") {
      const mode = statSync(config.path).mode & 0o777;
      check(mode === 0o600, "config.json is chmod 600", `mode ${mode.toString(8)}`);
    }
    const owner = process.env.RELAY_OWNER_USER_ID ?? loaded?.owner_user_id;
    check(
      Boolean(owner),
      "owner pinned (owner_user_id)",
      owner ?? "missing; re-run `relaymessenger pair` or set RELAY_OWNER_USER_ID",
    );
    let origin = loaded!.api_origin;
    try {
      origin = resolveApiOrigin(loaded!.api_origin);
      if (process.env.RELAY_API_ORIGIN) {
        out(`info  RELAY_API_ORIGIN override active (${origin}); development/testing only`);
      }
    } catch (error: any) {
      check(false, "RELAY_API_ORIGIN valid", String(error?.message ?? error));
    }
    try {
      const client = new RelayClient(origin, loaded!.agent_token);
      const me = (await client.getMe()) as any;
      const handle = me?.agent?.handle ?? me?.handle;
      check(true, `API reachable (${origin})`, handle ? `@${handle}` : undefined);
    } catch (error: any) {
      check(false, `API reachable (${origin})`, String(error?.message ?? error));
    }
  } else {
    out("     run `relaymessenger pair` to connect this machine to a Relay agent");
  }

  if (loaded?.agent_token) {
    // Match `start`: durable state is scoped to the effective origin.
    let effectiveOrigin = loaded.api_origin;
    try {
      effectiveOrigin = resolveApiOrigin(loaded.api_origin);
    } catch {
      // Invalid override already reported above; fall back to the paired origin.
    }
    const runtimeHome = runtimeHomeForConfig(
      { ...loaded, api_origin: effectiveOrigin },
      dirname(config.path),
    );
    try {
      const state = readStateSnapshot(runtimeHome);
      const pendingEvents = Object.values(state.pending_events).reduce(
        (sum, queue) => sum + queue.length,
        0,
      );
      const pendingApprovals = new ApprovalStore(runtimeHome).list().length;
      out(
        `info  state: cursor=${state.cursor}, pending_events=${pendingEvents}, ` +
          `pending_approvals=${pendingApprovals}, owner_conversation=${state.owner_conversation_id ?? "unset"} ` +
          `(${join(runtimeHome, "state.json")})`,
      );
    } catch (error) {
      check(false, "runtime state readable", String(error));
    }
  } else {
    out("info  runtime state unavailable until this machine is paired");
  }

  for (const [engine, pkg] of Object.entries(ADAPTER_PACKAGES)) {
    try {
      const entrypoint = adapterEntrypoint(engine as "claude" | "codex");
      check(
        existsSync(entrypoint),
        `${engine} adapter installed (${pkg}@${ADAPTER_VERSIONS[engine]})`,
        entrypoint,
      );
    } catch (error) {
      check(false, `${engine} adapter installed (${pkg}@${ADAPTER_VERSIONS[engine]})`, String(error));
    }
  }

  for (const [engine, spec] of Object.entries(EXTERNAL_ENGINE_SPECS)) {
    const lookup = crossSpawn.sync(process.platform === "win32" ? "where.exe" : "which", [spec.command], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (lookup.status !== 0) {
      out(`info  ${engine}: not installed; ${spec.docsUrl}`);
      continue;
    }
    const version = crossSpawn.sync(spec.command, spec.versionArgs, {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    check(
      version.status === 0,
      `${engine} binary present`,
      version.stdout?.trim() || version.stderr?.trim(),
    );
    if (spec.checkArgs) {
      const readiness = crossSpawn.sync(spec.command, spec.checkArgs, {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      check(
        readiness.status === 0,
        `${engine} ACP readiness`,
        readiness.stdout?.trim() || readiness.stderr?.trim(),
      );
    }
  }

  // Warn (not fail) when Claude settings disable phone approvals entirely.
  const bypass = claudeBypassWarning();
  if (bypass) out(`warn  ${bypass}`);

  const codexConfig = join(homedir(), ".codex", "config.toml");
  out(
    existsSync(codexConfig)
      ? `info  codex config present (${codexConfig}); run \`relaymessenger install-codex\` to wire notify + approvals`
      : "info  no ~/.codex/config.toml; install Codex or skip install-codex",
  );

  out("");
  out(healthy ? "All checks passed." : "Some checks failed. See above.");
  return healthy;
}
