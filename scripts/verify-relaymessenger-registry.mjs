import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expected = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/relaymessenger/package.json"), "utf8"),
);
const temp = mkdtempSync(join(tmpdir(), "relaymessenger-registry-smoke-"));

try {
  writeFileSync(
    join(temp, "package.json"),
    `${JSON.stringify({ name: "relaymessenger-registry-smoke", private: true }, null, 2)}\n`,
  );
  let installed = false;
  let lastFailure = "";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--no-audit", "--no-fund", "--prefer-online", `@relaymessenger/Relay-CLI@${expected.version}`],
      { cwd: temp, encoding: "utf8" },
    );
    if (result.status === 0) {
      installed = true;
      break;
    }
    lastFailure = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (attempt < 6) await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  assert.equal(installed, true, `registry install did not converge:\n${lastFailure}`);

  const installedRoot = join(temp, "node_modules", "@relaymessenger", "cli");
  const installedPkg = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedPkg.version, expected.version);
  for (const bundledFile of [
    "claude-plugin/marketplace/.claude-plugin/marketplace.json",
    "claude-plugin/marketplace/plugins/relay/.claude-plugin/plugin.json",
    "claude-plugin/marketplace/plugins/relay/commands/configure.md",
    "claude-plugin/marketplace/plugins/relay/runtime/server.mjs",
    "claude-plugin/marketplace/plugins/relay/LICENSE",
    "claude-plugin/marketplace/plugins/relay/README.md",
  ]) {
    assert.equal(existsSync(join(installedRoot, bundledFile)), true, `registry install missing ${bundledFile}`);
  }
  const openclawArchives = readdirSync(join(installedRoot, "openclaw-plugin"))
    .filter((name) => name.endsWith(".tgz"));
  assert.equal(openclawArchives.length, 1, "registry install must contain one OpenClaw plugin archive");
  const help = execFileSync(process.execPath, [join(installedRoot, "dist", "cli.js"), "--help"], {
    cwd: temp,
    encoding: "utf8",
  });
  assert.match(help, /relaymessenger pair/);
  for (const adapter of [
    "@agentclientprotocol/claude-agent-acp/dist/index.js",
    "@agentclientprotocol/codex-acp/dist/index.js",
  ]) {
    const path = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(require.resolve(${JSON.stringify(adapter)}))`],
      { cwd: installedRoot, encoding: "utf8" },
    );
    assert.equal(existsSync(path), true, `registry install missing ${adapter}`);
  }
  process.stdout.write(`registry-installed @relaymessenger/Relay-CLI@${expected.version} smoke passed\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
