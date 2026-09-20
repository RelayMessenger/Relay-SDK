import { execFileSync } from "node:child_process";
import {
  cpSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "relay-agent-starter-"));
const installed = join(temporary, "cloudflare-think-agent");
let candidateTestEnv = {};
const excluded = new Set([
  ".artifacts",
  ".dev.vars",
  ".git",
  ".wrangler",
  "coverage",
  "node_modules",
]);

function include(path) {
  const name = relative(source, path).split(/[\\/]/u)[0];
  return !excluded.has(name);
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: installed,
    env: { ...process.env, ...candidateTestEnv, CI: "1" },
    stdio: "inherit",
  });
}

try {
  cpSync(source, installed, { filter: include, recursive: true });
  const candidateMode = process.env.RELAY_SDK_CANDIDATE_TARBALL !== undefined
    || process.env.RELAY_CHAT_SDK_CANDIDATE_TARBALL !== undefined;
  if (candidateMode) {
    // Monorepo-only candidate experiment, explicitly distinct from the default
    // standalone locked-registry proof. Never edit the source manifest or lock.
    const { candidateTarball, candidateConsumerManifest, assertInstalledCandidate } = await import("../../../packages/sdk/scripts/candidate-tarball.mjs");
    const candidates = [
      candidateTarball({ name: "@relaymessenger/sdk", variable: "RELAY_SDK_CANDIDATE_TARBALL" }),
      candidateTarball({ name: "@relaymessenger/chat-sdk-adapter", variable: "RELAY_CHAT_SDK_CANDIDATE_TARBALL" }),
    ];
    if (candidates.some(candidate => !candidate)) throw new Error("Think candidate validation requires both SDK and Chat SDK tarballs");
    const manifestPath = join(installed, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log(JSON.stringify({ validationMode: "local-candidate-not-registry", originalDependencies: manifest.dependencies }));
    // Carry the unchanged historical receipt and canonical proof helper into
    // this disposable standalone copy. Child tests must not inherit the root
    // workspace overlay's lock path.
    const artifacts = join(installed, ".artifacts");
    mkdirSync(artifacts, { recursive: true });
    const lockedFile = join(artifacts, "locked-package-lock.json");
    cpSync(resolve(process.env.RELAY_THINK_LOCKED_LOCKFILE ?? join(source, "package-lock.json")), lockedFile);
    const helper = join(artifacts, "candidate-tarball.mjs");
    cpSync(fileURLToPath(new URL("../../../packages/sdk/scripts/candidate-tarball.mjs", import.meta.url)), helper);
    candidateTestEnv = {
      RELAY_THINK_CANDIDATE_HELPER: helper,
      RELAY_THINK_CANDIDATE_LOCKFILE: join(installed, "package-lock.json"),
      RELAY_THINK_LOCKED_LOCKFILE: lockedFile,
    };
    writeFileSync(manifestPath, JSON.stringify(candidateConsumerManifest(manifest, candidates)));
    rmSync(join(installed, "package-lock.json"));
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    for (const candidate of candidates) assertInstalledCandidate(installed, manifestPath, candidate);
  } else {
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  }

  run("npm", ["run", "types"]);
  run("npm", ["run", "types:check"]);
  run("npm", ["run", "check"]);
  run("npm", ["run", "test:unit"]);
  run("npm", ["run", "test:workerd"]);
  run("npm", ["run", "dry-run"]);

  console.log(`installed template ok (${candidateMode ? "local candidates; NOT registry/release validation" : "locked registry dependencies"}): ${basename(installed)}`);
} finally {
  if (process.env.RELAY_KEEP_INSTALLED_TEMPLATE !== "1") {
    rmSync(temporary, { force: true, recursive: true });
  } else {
    console.log(`kept installed template: ${installed}`);
  }
}
