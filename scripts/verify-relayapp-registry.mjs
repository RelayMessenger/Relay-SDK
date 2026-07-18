import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expected = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/relayapp/package.json"), "utf8"),
);
const temp = mkdtempSync(join(tmpdir(), "relayapp-registry-smoke-"));

try {
  writeFileSync(
    join(temp, "package.json"),
    `${JSON.stringify({ name: "relayapp-registry-smoke", private: true }, null, 2)}\n`,
  );
  let installed = false;
  let lastFailure = "";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--no-audit", "--no-fund", "--prefer-online", `relayapp@${expected.version}`],
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

  const installedRoot = join(temp, "node_modules", "relayapp");
  const installedPkg = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedPkg.version, expected.version);
  const help = execFileSync(process.execPath, [join(installedRoot, "dist", "cli.js"), "--help"], {
    cwd: temp,
    encoding: "utf8",
  });
  assert.match(help, /relayapp pair/);
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
  process.stdout.write(`registry-installed relayapp@${expected.version} smoke passed\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
