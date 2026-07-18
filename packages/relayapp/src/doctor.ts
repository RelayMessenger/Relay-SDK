/** `relayapp doctor` — environment and pairing health checks. */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "./api.js";
import { ADAPTER_PACKAGES } from "./engine/acp.js";
import { ApprovalStore, ConfigStore, readStateSnapshot, relayappHome } from "./store.js";

export async function doctor(out: (line: string) => void = console.log): Promise<boolean> {
  let healthy = true;
  const check = (ok: boolean, label: string, detail?: string) => {
    healthy = healthy && ok;
    out(`${ok ? "ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };

  const [major] = process.versions.node.split(".").map(Number);
  check((major ?? 0) >= 18, "node >= 18", `running ${process.versions.node}`);

  const npx = spawnSync("npx", ["--version"], { encoding: "utf8" });
  check(npx.status === 0, "npx available", npx.stdout?.trim());

  const config = new ConfigStore();
  const loaded = config.load();
  if (check(Boolean(loaded?.agent_token), "paired (config.json has agent_token)", config.path)) {
    const mode = statSync(config.path).mode & 0o777;
    check(mode === 0o600, "config.json is chmod 600", `mode ${mode.toString(8)}`);
    const owner = process.env.RELAY_OWNER_USER_ID ?? loaded?.owner_user_id;
    check(
      Boolean(owner),
      "owner pinned (owner_user_id)",
      owner ?? "missing — re-run `relayapp pair` or set RELAY_OWNER_USER_ID",
    );
    try {
      const client = new RelayClient(loaded!.api_origin, loaded!.agent_token);
      const me = (await client.getMe()) as any;
      check(true, `API reachable (${loaded!.api_origin})`, me?.handle ? `@${me.handle}` : undefined);
    } catch (error: any) {
      check(false, `API reachable (${loaded!.api_origin})`, String(error?.message ?? error));
    }
  } else {
    out("     run `relayapp pair` to connect this machine to a Relay agent");
  }

  const state = readStateSnapshot();
  const pendingEvents = Object.values(state.pending_events).reduce(
    (sum, queue) => sum + queue.length,
    0,
  );
  const pendingApprovals = new ApprovalStore().list().length;
  out(
    `info  state: cursor=${state.cursor}, pending_events=${pendingEvents}, ` +
      `pending_approvals=${pendingApprovals}, owner_conversation=${state.owner_conversation_id ?? "unset"} ` +
      `(${join(relayappHome(), "state.json")})`,
  );

  for (const [engine, pkg] of Object.entries(ADAPTER_PACKAGES)) {
    const probe = spawnSync("npm", ["view", pkg, "version"], { encoding: "utf8", timeout: 20_000 });
    check(probe.status === 0, `${engine} adapter resolvable (${pkg})`, probe.stdout?.trim());
  }

  // opencode is an optional engine: absence is informational, but a binary
  // that is present yet cannot report a version is a real failure.
  const opencodeProbe = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (opencodeProbe.error && (opencodeProbe.error as NodeJS.ErrnoException).code === "ENOENT") {
    out("info  no opencode binary on PATH — install https://opencode.ai to use --engine opencode");
  } else {
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
