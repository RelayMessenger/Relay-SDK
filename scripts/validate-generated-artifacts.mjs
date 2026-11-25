import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_OPENAPI_PATH = "contracts/relay-v1-openapi.yaml";

const FORBIDDEN_RULES = [
  {
    test: (path) => /(?:^|\/)worker-configuration\.d\.ts$/u.test(path),
    reason: "generated Wrangler type declaration must stay untracked",
  },
  {
    test: (path) => /(?:^|\/)relay-openapi\.yaml$/u.test(path),
    reason: `duplicate OpenAPI spec; use ${CANONICAL_OPENAPI_PATH}`,
  },
  {
    test: (path) =>
      /(?:^|\/)relay-v1-openapi\.yaml$/u.test(path)
      && path !== CANONICAL_OPENAPI_PATH,
    reason: `duplicate Relay v1 OpenAPI spec; canonical copy is ${CANONICAL_OPENAPI_PATH}`,
  },
  {
    test: (path) => path === "packages/claude-code/runtime/server.mjs",
    reason: "generated Claude Code runtime bundle must stay untracked",
  },
];

export function findForbiddenTrackedFiles(paths) {
  const violations = [];
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/gu, "/").trim();
    if (!normalized) continue;
    for (const rule of FORBIDDEN_RULES) {
      if (rule.test(normalized)) {
        violations.push(`${normalized}: ${rule.reason}`);
      }
    }
  }
  return violations;
}

export function validateTrackedGeneratedArtifacts(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const violations = findForbiddenTrackedFiles(tracked);
  assert.deepEqual(
    violations,
    [],
    `Forbidden generated or duplicate artifact committed:\n${violations.join("\n")}`,
  );
  return tracked.length;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const count = validateTrackedGeneratedArtifacts();
  console.log(`validated ${count} tracked files: no forbidden generated or duplicate artifacts`);
}
