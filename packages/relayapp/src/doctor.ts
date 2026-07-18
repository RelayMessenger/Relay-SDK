/** `relayapp doctor` — environment and pairing health checks. */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RelayClient } from "./api.js";
import { ADAPTER_PACKAGES, ADAPTER_VERSIONS, adapterEntrypoint } from "./engine/acp.js";
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
    out(`${ok ? "ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
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
      owner ?? "missing — re-run `relayapp pair` or set RELAY_OWNER_USER_ID",
    );
    try {
      const client = new RelayClient(loaded!.api_origin, loaded!.agent_token);
      const me = (await client.getMe()) as any;
      const handle = me?.agent?.handle ?? me?.handle;
      check(true, `API reachable (${loaded!.api_origin})`, handle ? `@${handle}` : undefined);
    } catch (error: any) {
      check(false, `API reachable (${loaded!.api_origin})`, String(error?.message ?? error));
    }
  } else {
    out("     run `relayapp pair` to connect this machine to a Relay agent");
  }

  if (loaded?.agent_token) {
    const runtimeHome = runtimeHomeForConfig(loaded, dirname(config.path));
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

  // opencode is an optional engine: absence is informational, but a binary
  // that is present yet cannot report a version is a real failure.
  const opencodeLookup = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["opencode"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (opencodeLookup.status !== 0) {
    out("info  no opencode binary on PATH — install https://opencode.ai to use --engine opencode");
  } else {
    const opencodeProbe = spawnSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    check(
      opencodeProbe.status === 0,
      "opencode binary present",
      opencodeProbe.stdout?.trim() || opencodeProbe.stderr?.trim(),
    );
  }

  const codexConfig = join(homedir(), ".codex", "config.toml");
  out(
    existsSync(codexConfig)
      ? `info  codex config present (${codexConfig}); run \`relayapp install-codex\` to wire notify + approvals`
      : "info  no ~/.codex/config.toml — install Codex or skip install-codex",
  );

  out("");
  out(healthy ? "All checks passed." : "Some checks failed — see above.");
  return healthy;
}
