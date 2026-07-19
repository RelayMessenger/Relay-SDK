import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeBypassWarning, resolveClaudeDefaultMode } from "./claude-settings.js";

function settingsDir(root: string): string {
  const dir = join(root, ".claude");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "relayapp-claude-settings-"));
}

test("bypassPermissions in user settings produces a warning, not a failure", () => {
  const home = tempRoot();
  const project = tempRoot();
  writeFileSync(
    join(settingsDir(home), "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
  const resolved = resolveClaudeDefaultMode(project, home);
  assert.equal(resolved?.mode, "bypassPermissions");
  assert.equal(resolved?.source, join(home, ".claude", "settings.json"));
  assert.match(claudeBypassWarning(project, home)!, /Allow\/Deny cards will not appear/);
});

test("project settings override user settings for the resolved defaultMode", () => {
  const home = tempRoot();
  const project = tempRoot();
  writeFileSync(
    join(settingsDir(home), "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
  writeFileSync(
    join(settingsDir(project), "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "default" } }),
  );
  assert.equal(resolveClaudeDefaultMode(project, home)?.mode, "default");
  assert.equal(claudeBypassWarning(project, home), undefined);
});

test("project settings.local.json wins over the shared project file", () => {
  const home = tempRoot();
  const project = tempRoot();
  writeFileSync(
    join(settingsDir(project), "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
  );
  writeFileSync(
    join(settingsDir(project), "settings.local.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
  const resolved = resolveClaudeDefaultMode(project, home);
  assert.equal(resolved?.mode, "bypassPermissions");
  assert.equal(resolved?.source, join(project, ".claude", "settings.local.json"));
});

test("detection is best-effort: absent or malformed settings stay silent", () => {
  const home = tempRoot();
  const project = tempRoot();
  assert.equal(resolveClaudeDefaultMode(project, home), undefined);
  assert.equal(claudeBypassWarning(project, home), undefined);

  writeFileSync(join(settingsDir(home), "settings.json"), "{ not json");
  writeFileSync(join(settingsDir(project), "settings.json"), JSON.stringify({ permissions: {} }));
  assert.equal(resolveClaudeDefaultMode(project, home), undefined);
  assert.equal(claudeBypassWarning(project, home), undefined);
});
