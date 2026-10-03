// A developer outside Relay reads every README on GitHub and npm, and builds
// against production: the App Store app only reaches production agents. On
// 2026-10-03 a MHacks student followed "a staging agent" and built an agent the
// app could never reach. Maintainer notes that must name staging live in
// CONTRIBUTING.md files. The allowlist is empty on purpose.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = new Set();

export function stagingLines(text) {
  return text.split("\n").flatMap((line, index) =>
    /staging/iu.test(line) ? [`${index + 1}: ${line.trim()}`] : []);
}

test("the check finds staging in prose and passes production prose", () => {
  assert.deepEqual(stagingLines("- a staging agent and Agent Token\n"), [
    "1: - a staging agent and Agent Token",
  ]);
  assert.deepEqual(stagingLines("- an agent and its Agent Token\n"), []);
  assert.equal(ALLOWLIST.size, 0);
});

test("no public README names staging", () => {
  const readmes = execFileSync("git", ["ls-files", "*README.md"], {
    cwd: root,
    encoding: "utf8",
  }).split("\n").filter(Boolean);
  assert.ok(readmes.includes("cookbook/cloudflare-think-agent/README.md"));
  const found = readmes
    .filter((path) => !ALLOWLIST.has(path))
    .flatMap((path) => stagingLines(readFileSync(join(root, path), "utf8"))
      .map((line) => `${path}:${line}`));
  assert.deepEqual(found, []);
});
