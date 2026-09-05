import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("published artifact contracts", () => {
  it("keeps npm, plugin, marketplace, SDK, and branded repository metadata aligned", () => {
    const pkg = json("package.json");
    const plugin = json(".claude-plugin/plugin.json");
    const marketplace = json(".claude-plugin/marketplace.json");
    const lock = json("contracts/relay-v1.lock.json");
    const source = json("SOURCE.json");
    const sourceLock = JSON.parse(
      readFileSync(resolve(root, "../..", "sources.lock.json"), "utf8"),
    );
    expect(pkg.name).toBe("relay-claude-channel");
    expect(pkg.packageManager).toBe("npm@12.0.2");
    expect(pkg.version).toBe("0.3.0-staging.1");
    expect(pkg.version).toBe(plugin.version);
    expect(pkg.version).toBe(marketplace.plugins[0].version);
    expect(pkg.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
      tag: "staging",
      provenance: true,
    });
    expect(plugin.name).toBe("relay");
    expect(marketplace.plugins[0].source).toBe("./plugin");
    expect(marketplace.plugins[0].strict).toBe(true);
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/RelayMessenger/Relay-SDK.git",
      directory: "packages/claude-code",
    });
    expect(pkg.bugs).toEqual({
      url: "https://github.com/RelayMessenger/Relay-SDK/issues",
    });
    expect(source).toEqual({
      ...sourceLock.imports["packages/claude-code"],
      imported_at: "2026-09-01",
      canonical: "Relay-SDK",
    });
    expect(plugin.repository).toBe("https://github.com/RelayMessenger/Relay-SDK");
    expect(plugin.homepage).toContain("/Relay-SDK/tree/main/packages/claude-code");
    expect(marketplace.plugins[0].repository).toBe(
      "https://github.com/RelayMessenger/Relay-SDK",
    );
    expect(marketplace.plugins[0].homepage).toContain(
      "/Relay-SDK/tree/main/packages/claude-code",
    );
    expect(read("README.md")).toContain(
      "/absolute/path/to/Relay-SDK/packages/claude-code",
    );
    expect(pkg.dependencies["@relaymessenger/sdk"]).toBe("0.3.0-staging.5");
    expect(lock.relayServer.sha256).toBe(
      "fe9fb79d522063bb79f70e41e1e8bb42f765d469579183b8d7df0619a03ae279",
    );
  });

  it("declares current Claude plugin channel and sensitive user configuration", () => {
    const plugin = json(".claude-plugin/plugin.json");
    const mcp = json(".mcp.json");
    expect(plugin.channels).toEqual([{ server: "relay" }]);
    expect(plugin.userConfig.agent_token.sensitive).toBe(true);
    expect(plugin.defaultEnabled).toBe(false);
    expect(mcp.mcpServers.relay.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/runtime/server.mjs"]);
    expect(mcp.mcpServers.relay.env.RELAY_AGENT_TOKEN).toBe("${user_config.agent_token}");
    expect(plugin.userConfig.allowed_senders.description).not.toMatch(/permission|verdict/iu);
    expect(json("package.json").dependencies.zod).toBeUndefined();
  });

  it("hash-binds package, generated runtime, and dependency-free plugin identity", () => {
    const pkg = json("package.json");
    const rootPlugin = json(".claude-plugin/plugin.json");
    const packagedPlugin = json("plugin/.claude-plugin/plugin.json");
    const runtime = readFileSync(resolve(root, "runtime/server.mjs"));
    const packagedRuntime = readFileSync(resolve(root, "plugin/runtime/server.mjs"));
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(rootPlugin).toEqual(packagedPlugin);
    expect(rootPlugin.version).toBe(pkg.version);
    expect(hash(runtime)).toBe(hash(packagedRuntime));
    expect(runtime.includes(Buffer.from(JSON.stringify(pkg.version)))).toBe(true);
  });

  it("keeps the package release guard monorepo-bound, exact-SHA, and non-injectable", () => {
    const guard = read("scripts/staging-release-guard.mjs");
    expect(guard).toContain("GITHUB_REPOSITORY");
    expect(guard).toContain("GITHUB_WORKSPACE");
    expect(guard).toContain("RelayMessenger/Relay-SDK");
    expect(guard).toContain("packages/claude-code");
    expect(guard).toContain("refs/heads/staging");
    expect(guard).toMatch(/releaseTag,\s*"staging"/u);
    expect(guard).toMatch(/tag:\s*"staging"/u);
    expect(guard).toMatch(/provenance:\s*true/u);
    expect(guard).toMatch(/releaseSha,\s*\/\^\[0-9a-f\]\{40\}\$\/u/u);
    expect(guard).toMatch(/workflowSha,\s*releaseSha/u);
    expect(guard).toMatch(/execFileSync\("git", \["rev-parse", "HEAD"\]/u);
    expect(guard).toContain("RELEASE_TARBALL");
    expect(guard).toContain("package/runtime/server.mjs");
    expect(guard).toContain("package/plugin/runtime/server.mjs");
    expect(guard).not.toMatch(/execSync|shell:\s*true/u);
    const rejected = spawnSync(process.execPath, ["scripts/staging-release-guard.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_SHA: `${"a".repeat(40)};printf injected`,
        RELEASE_VERSION: "0.3.0-staging.1",
        RELEASE_TAG: "staging",
        GITHUB_REF: "refs/heads/staging",
        GITHUB_SHA: "a".repeat(40),
      },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      "RELEASE_SHA must be one exact lowercase Git commit SHA",
    );
    expect(rejected.stderr).not.toContain("not a git repository");
  });

  it("runs the full check, test, contract, build, hash, package, and Claude gates", () => {
    const pkg = json("package.json");
    expect(pkg.scripts.prepack).toBe("npm run verify");
    for (const gate of ["check", "test", "contract:check", "build", "artifact:check"]) {
      expect(pkg.scripts.verify).toContain(`npm run ${gate}`);
    }
    expect(pkg.scripts["pack:smoke"]).toContain("npm run prepack");
    expect(pkg.scripts["release:validate"]).toContain("npm run pack:smoke");
    expect(pkg.scripts["release:validate"]).toContain("npm run claude:validate");
    expect(pkg.scripts["claude:validate"]).toContain("claude plugin validate ./plugin --strict");
    expect(pkg.scripts["claude:validate"]).toContain(
      "claude plugin validate ./plugin/commands --strict",
    );
  });

  it("keeps Claude permissions local and schema preflight snapshot/WAL-aware", () => {
    const server = read("server.ts");
    const channel = read("src/channel.ts");
    const bridge = read("src/bridge.ts");
    const state = read("src/state.ts");
    expect(server).toContain('name: "complete_processing"');
    expect(channel).toContain('completeDeliveryTurn(origin.deliveryId, "completed")');
    expect(channel).toContain('clearActiveTurn("failed")');
    expect(server).not.toContain('"claude/channel/permission"');
    expect(server).not.toContain("notifications/claude/channel/permission_request");
    expect(server).not.toContain("notifications/claude/channel/permission");
    expect(channel).not.toMatch(/Permission|permission card|verdict/u);
    expect(bridge).not.toMatch(/Permission|permission card|verdict/u);
    expect(state).toContain("ACTIVE_TURN_TTL_MS");
    expect(state).toContain("stableStateSnapshot(path)");
    expect(state).toContain('SQLITE_STATE_SUFFIXES = ["", "-wal", "-shm"]');
    expect(state).toContain("new DatabaseSync(snapshot.databasePath, { readOnly: true })");
    expect(state).toContain('db.exec("PRAGMA query_only = ON")');
    expect(state).not.toContain("immutable=1");
  });
});
