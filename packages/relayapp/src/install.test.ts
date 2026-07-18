import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { installCodex, mergeCodexConfigToml, mergeHooksJson } from "./install.js";

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
  const configPath = join(codexHome, "config.toml");
  const original = `# mine\nmodel = "gpt-5.2-codex"\n`;
  writeFileSync(configPath, original);
  installCodex(codexHome, () => {});
  assert.equal(readFileSync(`${configPath}.bak`, "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal(statSync(`${configPath}.bak`).mode & 0o777, 0o600);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(codexHome, "hooks.json")).mode & 0o777, 0o600);
  }
  // Second run: no changes, .bak untouched.
  const afterFirst = readFileSync(configPath, "utf8");
  installCodex(codexHome, () => {});
  assert.equal(readFileSync(configPath, "utf8"), afterFirst);
  assert.equal(readFileSync(`${configPath}.bak`, "utf8"), original);
  // Fresh-file case: nothing to back up.
  const emptyHome = mkdtempSync(join(tmpdir(), "relayapp-codex-"));
  installCodex(emptyHome, () => {});
  assert.equal(existsSync(join(emptyHome, "config.toml.bak")), false);
});
