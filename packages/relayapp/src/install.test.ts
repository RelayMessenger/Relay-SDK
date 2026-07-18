import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  installClaude,
  installCodex,
  installOpenClaw,
  mergeClaudeChannelEnv,
  mergeCodexConfigToml,
  mergeHooksJson,
  mergeOpenClawConfig,
} from "./install.js";
import { CodexNotifyPolicyStore, ConfigStore } from "./store.js";

test("install-codex: fresh config.toml gets mcp server + notify", () => {
  const { toml, report } = mergeCodexConfigToml("");
  assert.equal(report.changed, true);
  const doc = parseToml(toml) as any;
  assert.deepEqual(doc.mcp_servers.relay, { command: "relayapp", args: ["mcp"] });
  assert.deepEqual(doc.notify, ["relayapp", "notify"]);
});

test("install-codex: merge never clobbers existing user config", () => {
  const existing = `
# my precious config
model = "gpt-5.2-codex"
approval_policy = "on-request"
notify = ["terminal-notifier", "-message"]

[mcp_servers.github]
command = "gh-mcp"
args = ["serve"]

[profiles.fast]
model = "gpt-5.2-codex-mini"
`;
  const { toml, report } = mergeCodexConfigToml(existing);
  const doc = parseToml(toml) as any;
  // Everything the user had survives byte-for-byte in value terms.
  assert.equal(doc.model, "gpt-5.2-codex");
  assert.equal(doc.approval_policy, "on-request");
  assert.deepEqual(doc.notify, ["terminal-notifier", "-message"]); // NOT clobbered
  assert.deepEqual(doc.mcp_servers.github, { command: "gh-mcp", args: ["serve"] });
  assert.equal(doc.profiles.fast.model, "gpt-5.2-codex-mini");
  // And the relay server is added alongside.
  assert.deepEqual(doc.mcp_servers.relay, { command: "relayapp", args: ["mcp"] });
  assert.ok(report.notes.some((note) => note.includes("left existing notify unchanged")));
});

test("install-codex: existing relay mcp server entry is preserved as-is", () => {
  const existing = `
[mcp_servers.relay]
command = "my-custom-relayapp"
`;
  const { toml } = mergeCodexConfigToml(existing);
  const doc = parseToml(toml) as any;
  assert.equal(doc.mcp_servers.relay.command, "my-custom-relayapp");
});

test("install-codex reports a truthful partial setup when existing integrations win", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "relayapp-codex-partial-"));
  writeFileSync(
    join(codexHome, "config.toml"),
    'notify = ["other"]\n\n[mcp_servers.relay]\ncommand = "other-relay"\n',
  );
  const lines: string[] = [];
  installCodex(codexHome, (line) => lines.push(line), {
    projectRoot: mkdtempSync(join(tmpdir(), "relayapp-project-")),
    policy: new CodexNotifyPolicyStore(mkdtempSync(join(tmpdir(), "relayapp-policy-"))),
  });
  const output = lines.join("\n");
  assert.match(output, /setup is partial/);
  assert.match(output, /MCP relay_send_message: inactive/);
  assert.match(output, /final-message notify: inactive/);
  assert.doesNotMatch(output, /Codex will send the final assistant message/);
});

test("install-codex: config merge is idempotent", () => {
  const first = mergeCodexConfigToml("");
  const second = mergeCodexConfigToml(first.toml);
  assert.equal(second.report.changed, false);
  assert.deepEqual(parseToml(second.toml), parseToml(first.toml));
});

test("install-codex: hooks.json gains PermissionRequest handler, append-only", () => {
  const existing = JSON.stringify({
    hooks: {
      PermissionRequest: [
        { matcher: "Bash", hooks: [{ type: "command", command: "my-audit-hook" }] },
      ],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "other" }] }],
    },
  });
  const { json, report } = mergeHooksJson(existing);
  assert.equal(report.changed, true);
  const doc = JSON.parse(json);
  // User's handlers survive, ours is appended after them.
  assert.equal(doc.hooks.PermissionRequest.length, 2);
  assert.equal(doc.hooks.PermissionRequest[0].hooks[0].command, "my-audit-hook");
  assert.equal(
    doc.hooks.PermissionRequest[1].hooks[0].command,
    "relayapp hook permission-request",
  );
  assert.equal(doc.hooks.PreToolUse[0].hooks[0].command, "other");
  // Idempotent.
  const again = mergeHooksJson(json);
  assert.equal(again.report.changed, false);
});

test("install-codex: invalid hooks.json is refused, not overwritten", () => {
  assert.throws(() => mergeHooksJson("{not json"), /not valid JSON/);
});

test("M3 regression: user comments and formatting survive the merge verbatim", () => {
  const existing = `# my precious config
# do not touch

model = "gpt-5.2-codex"   # inline comment too

[mcp_servers.github]
command = "gh-mcp"   # keep me
`;
  const { toml } = mergeCodexConfigToml(existing);
  // The original text is embedded untouched — comments, spacing, ordering.
  assert.ok(toml.includes(existing), "original file must survive byte-for-byte");
  assert.ok(toml.includes("# my precious config"));
  assert.ok(toml.includes('command = "gh-mcp"   # keep me'));
  // notify was prepended as a top-level key (before any [table]).
  assert.ok(toml.indexOf("notify = ") < toml.indexOf("[mcp_servers.github]"));
  // relay table appended; result still parses.
  const doc = parseToml(toml) as any;
  assert.deepEqual(doc.mcp_servers.relay, { command: "relayapp", args: ["mcp"] });
});

test("M3: invalid config.toml is refused, not overwritten", () => {
  assert.throws(() => mergeCodexConfigToml("this = = broken"), /not valid TOML/);
});

test("installCodex writes private backups and atomically replaces private live config", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "relayapp-codex-"));
  const relayHome = mkdtempSync(join(tmpdir(), "relayapp-policy-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "relayapp-project-"));
  const options = { policy: new CodexNotifyPolicyStore(relayHome), projectRoot };
  const configPath = join(codexHome, "config.toml");
  const original = `# mine\nmodel = "gpt-5.2-codex"\n`;
  writeFileSync(configPath, original);
  installCodex(codexHome, () => {}, options);
  assert.equal(readFileSync(`${configPath}.bak`, "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal(statSync(`${configPath}.bak`).mode & 0o777, 0o600);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(codexHome, "hooks.json")).mode & 0o777, 0o600);
  }
  // Second run: no changes, .bak untouched.
  const afterFirst = readFileSync(configPath, "utf8");
  installCodex(codexHome, () => {}, options);
  assert.equal(readFileSync(configPath, "utf8"), afterFirst);
  assert.equal(readFileSync(`${configPath}.bak`, "utf8"), original);
  // Fresh-file case: nothing to back up.
  const emptyHome = mkdtempSync(join(tmpdir(), "relayapp-codex-"));
  installCodex(emptyHome, () => {}, options);
  assert.equal(existsSync(join(emptyHome, "config.toml.bak")), false);
  assert.equal(options.policy.matchProject(projectRoot), realpathSync(projectRoot));
});

test("install-claude securely copies paired identity without printing the token", () => {
  const relayHome = mkdtempSync(join(tmpdir(), "relayapp-claude-pair-"));
  const channelDir = mkdtempSync(join(tmpdir(), "relayapp-claude-channel-"));
  const config = new ConfigStore(relayHome);
  config.save({
    api_origin: "https://api.relayapp.im",
    agent_token: "rly_secret_never_log",
    owner_user_id: "usr_owner",
    agent: { id: "agt_1" },
  });
  const lines: string[] = [];
  const bundleDir = join(relayHome, "marketplace");
  for (const relative of [
    ".claude-plugin/marketplace.json",
    "plugins/relay/.claude-plugin/plugin.json",
    "plugins/relay/commands/configure.md",
    "plugins/relay/runtime/server.mjs",
    "plugins/relay/LICENSE",
    "plugins/relay/README.md",
  ]) {
    const path = join(bundleDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture\n");
  }
  const commands: string[][] = [];
  const options = {
    config,
    channelDir,
    bundleDir,
    installRoot: join(relayHome, "installed-claude"),
    runClaude: (_command: string, args: string[]) => {
      commands.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  installClaude((line) => lines.push(line), options);
  const envPath = join(channelDir, ".env");
  const contents = readFileSync(envPath, "utf8");
  assert.match(contents, /RELAY_AGENT_TOKEN=rly_secret_never_log/);
  assert.match(contents, /RELAY_BASE_URL=https:\/\/api\.relayapp\.im/);
  assert.match(contents, /RELAY_OWNER_USER_ID=usr_owner/);
  assert.equal(lines.join("\n").includes("rly_secret_never_log"), false);
  assert.deepEqual(commands[0], ["plugin", "validate", join(bundleDir, "plugins", "relay"), "--strict"]);
  assert.deepEqual(commands[1], ["plugin", "validate", bundleDir, "--strict"]);
  const persistentPlugin = commands[2]![2]!;
  const persistentMarketplace = dirname(dirname(persistentPlugin));
  assert.match(persistentMarketplace, /installed-claude[/\\][a-f0-9]{24}[/\\]marketplace$/);
  assert.deepEqual(commands[2], [
    "plugin",
    "validate",
    persistentPlugin,
    "--strict",
  ]);
  assert.deepEqual(commands[3], ["plugin", "marketplace", "add", persistentMarketplace]);
  assert.deepEqual(commands[4], ["plugin", "install", "relay@relayapp-bundled", "--scope", "user"]);
  assert.match(lines.join("\n"), /plugin:relay@relayapp-bundled/);
  if (process.platform !== "win32") assert.equal(statSync(envPath).mode & 0o777, 0o600);

  commands.length = 0;
  installClaude(() => {}, options);
  assert.equal(readFileSync(envPath, "utf8"), contents, "install is idempotent");
  assert.equal(commands.length, 5, "idempotent install revalidates and refreshes the local package path");
});

test("install-claude refuses to overwrite a different channel identity", () => {
  assert.throws(
    () =>
      mergeClaudeChannelEnv("RELAY_AGENT_TOKEN=other\n", {
        token: "paired",
        origin: "https://api.relayapp.im",
        ownerUserId: "usr_owner",
      }),
    /different RELAY_AGENT_TOKEN/,
  );
});

test("install-openclaw installs the bundled archive and configures owner-private identity", () => {
  const relayHome = mkdtempSync(join(tmpdir(), "relayapp-openclaw-pair-"));
  const openclawHome = mkdtempSync(join(tmpdir(), "relayapp-openclaw-home-"));
  const bundleDir = mkdtempSync(join(tmpdir(), "relayapp-openclaw-bundle-"));
  writeFileSync(join(bundleDir, "relayapp-openclaw-plugin-0.1.0.tgz"), "archive fixture");
  const config = new ConfigStore(relayHome);
  config.save({
    api_origin: "https://api.relayapp.im",
    agent_token: "rly_openclaw_secret",
    owner_user_id: "usr_owner",
    agent: { id: "agt_openclaw" },
  });
  const commands: string[][] = [];
  const lines: string[] = [];
  installOpenClaw((line) => lines.push(line), {
    config,
    openclawHome,
    bundleDir,
    installRoot: join(relayHome, "installed-openclaw"),
    runOpenClaw: (_command, args) => {
      commands.push(args);
      return { status: 0 };
    },
  });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0]!.slice(0, 2), ["plugins", "install"]);
  assert.match(commands[0]![2]!, /installed-openclaw[/\\][a-f0-9]{24}[/\\]relay-openclaw-plugin\.tgz$/);
  assert.equal(commands[0]![3], "--force");
  const tokenPath = join(openclawHome, "secrets", "relay-agent-token");
  assert.equal(readFileSync(tokenPath, "utf8"), "rly_openclaw_secret\n");
  const installedConfig = JSON.parse(readFileSync(join(openclawHome, "openclaw.json"), "utf8"));
  assert.deepEqual(installedConfig.plugins.allow, ["relay"]);
  assert.equal(installedConfig.plugins.entries.relay.enabled, true);
  assert.equal(installedConfig.channels.relay.tokenFile, tokenPath);
  assert.equal(installedConfig.channels.relay.baseUrl, "https://api.relayapp.im");
  assert.equal(lines.join("\n").includes("rly_openclaw_secret"), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(openclawHome, "openclaw.json")).mode & 0o777, 0o600);
  }
});

test("install-openclaw merge preserves unrelated config and refuses identity overwrite", () => {
  const existing = `${JSON.stringify({ gateway: { mode: "local" }, plugins: { allow: ["other"] } })}\n`;
  const merged = JSON.parse(mergeOpenClawConfig(existing, {
    token: "secret",
    tokenFile: "/private/token",
    baseUrl: "https://api.relayapp.im",
  }));
  assert.equal(merged.gateway.mode, "local");
  assert.deepEqual(merged.plugins.allow, ["other", "relay"]);
  assert.throws(
    () => mergeOpenClawConfig('{"channels":{"relay":{"token":"other"}}}', {
      token: "secret",
      tokenFile: "/private/token",
      baseUrl: "https://api.relayapp.im",
    }),
    /different token/,
  );
});
