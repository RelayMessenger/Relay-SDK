import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releasePackages } from "./release-packages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("workflow validation accepts standard Ubuntu runners and rejects paid or self-hosted labels", () => {
  const fixture = mkdtempSync(join(tmpdir(), "relay-workflow-runners-"));
  try {
    for (const path of [".github", "scripts", ".nvmrc", "package.json"]) {
      cpSync(join(root, path), join(fixture, path), { recursive: true });
    }
    for (const { directory } of Object.values(releasePackages)) {
      const manifest = join(directory, "package.json");
      mkdirSync(dirname(join(fixture, manifest)), { recursive: true });
      cpSync(join(root, manifest), join(fixture, manifest));
    }
    const workflow = join(fixture, ".github/workflows/ci.yml");
    const original = readFileSync(workflow, "utf8");
    for (const [label, accepted] of [
      ["ubuntu-24.04", true],
      ["ubuntu-latest", true],
      ["blacksmith-2vcpu-ubuntu-2404", false],
      ["self-hosted", false],
      ["ubuntu-24.04-16core", false],
    ]) {
      writeFileSync(workflow, original.replace(/runs-on: \S+/u, `runs-on: ${label}`));
      const result = spawnSync(process.execPath, ["scripts/validate-workflows.mjs"], {
        cwd: fixture,
        encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, accepted ? 0 : 1, `${label}: ${result.stderr}`);
      if (!accepted) {
        assert.ok(
          result.stderr.includes(`runs on ${label} instead of a standard GitHub-hosted Ubuntu runner`),
          result.stderr,
        );
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
