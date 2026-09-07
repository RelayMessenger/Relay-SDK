// Proves every cookbook folder is a self-contained project a developer can
// copy out of GitHub and run with `npm install && npm start` against
// production, with nothing but an Agent Token.
//
//   node scripts/validate-cookbook-standalone.mjs               copy, install, type-check
//   node scripts/validate-cookbook-standalone.mjs --link-check  workspace-side checks only
//   ... --only webhook-receiver                                  one folder
//
// Two properties, checked from two sides:
//
// 1. Standalone (default mode, network): each folder is copied to a temp dir
//    OUTSIDE the workspace, `npm install` runs against the real registry, the
//    installed @relaymessenger/sdk is a release build (never a staging
//    prerelease; the newest release when the folder carries no lockfile), and
//    `tsc --noEmit` runs from the folder's OWN devDependencies. The workspace
//    is never installed here, so nothing can leak in from it.
//
// 2. Workspace (--link-check, no network): every Relay dependency a cookbook
//    declares resolves to the workspace package (packages/<name>), so the
//    monorepo's own CI validates the cookbooks against the tree, not against
//    whatever the registry has. Every tsconfig stays inside its folder, and
//    the tools its scripts run are its own devDependencies.
//
// Why the sdk range is `^0.3.0-staging.0` and not `^0.3.0`: the release job
// (scripts/release-derive.mjs) rewrites only the packages it publishes and
// never commits back, so a cookbook manifest on main reads exactly as staging
// wrote it. A plain caret excludes the workspace's `X.Y.Z-staging.N`
// prerelease, so npm would install the registry copy inside the workspace
// too. A caret with a prerelease floor on the same X.Y.Z tuple matches both
// the workspace prerelease and the published `X.Y.Z` release, and npm
// resolves the highest, which is the release. The floor only covers ITS OWN
// tuple: when packages/sdk moves to `0.3.1-staging.0` the workspace stops
// satisfying `^0.3.0-staging.0`, and the link check below is what fails.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releasePackages } from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const cookbookRoot = join(root, "cookbook");
const linkCheckOnly = process.argv.includes("--link-check");
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const say = (message) => process.stdout.write(`${message}\n`);

const workspaceByName = new Map(
  Object.values(releasePackages).map((entry) => [entry.workspace, entry.directory]),
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// A folder that ships its own package-lock.json and a `test:installed` script
// pins exact published versions by contract (cloudflare-think-agent locks the
// adapter tarball's integrity in test/contracts.test.ts), so it can never
// resolve the workspace prerelease: the workspace-link rule below does not
// apply to it. Its `npm ci` from that lockfile in a temp copy, then its full
// test suite, runs under `npm run validate:cookbook`. The standalone check
// still applies: a copied folder must install a release build from npm and
// type-check on its own (measured passing on 2026-09-07 once it pinned
// sdk 0.3.0 and chat-sdk-adapter 0.3.0).
function selfProving(name) {
  const directory = join(cookbookRoot, name);
  return existsSync(join(directory, "package-lock.json"))
    && Boolean(readJson(join(directory, "package.json")).scripts?.["test:installed"]);
}

const cookbooks = readdirSync(cookbookRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(cookbookRoot, name, "package.json")))
  .filter((name) => only === null || name === only)
  .sort();
assert.ok(cookbooks.length > 0, `no cookbook matches ${only ?? "*"}`);
if (linkCheckOnly) {
  for (const name of cookbooks.filter(selfProving)) {
    say(`  ${name}: link check skipped; its lockfile pins published releases and test:installed proves it under validate:cookbook`);
  }
}
const checked = linkCheckOnly ? cookbooks.filter((name) => !selfProving(name)) : cookbooks;

// Every dependency field npm installs from.
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function relayDependencies(manifest) {
  const found = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (workspaceByName.has(name)) found.push({ field, name, range });
    }
  }
  return found;
}

function linkCheck(name) {
  const directory = join(cookbookRoot, name);
  const manifest = readJson(join(directory, "package.json"));
  const resolveFrom = createRequire(pathToFileURL(join(directory, "package.json")));

  // 2a. Every Relay dependency resolves to the workspace package.
  const relay = relayDependencies(manifest);
  assert.ok(relay.length > 0, `${name} declares no Relay package dependency`);
  for (const dependency of relay) {
    assert.doesNotMatch(
      dependency.range,
      /^(?:file|workspace|link):/u,
      `${name} pins ${dependency.name} with a workspace-only protocol (${dependency.range}); a copied folder cannot install it`,
    );
    const resolved = realpathSync(resolveFrom.resolve(`${dependency.name}/package.json`));
    const expected = realpathSync(join(root, workspaceByName.get(dependency.name), "package.json"));
    assert.equal(
      resolved,
      expected,
      `${name} resolves ${dependency.name} from ${relative(root, resolved)}, not the workspace ${relative(root, expected)}; `
        + `its range ${dependency.range} no longer matches the workspace version ${readJson(expected).version}`,
    );
    say(`  ${name}: ${dependency.name}@${dependency.range} -> workspace ${readJson(expected).version}`);
  }

  // 2b. No tsconfig reaches outside the folder.
  for (const file of readdirSync(directory).filter((entry) => /^tsconfig.*\.json$/u.test(entry))) {
    const config = readJson(join(directory, file));
    for (const target of [].concat(config.extends ?? [])) {
      assert.doesNotMatch(target, /^\.\.\//u, `${name}/${file} extends ${target}, outside the folder`);
      const resolved = resolve(directory, target);
      assert.ok(
        !relative(directory, resolved).startsWith(".."),
        `${name}/${file} extends ${target}, outside the folder`,
      );
      assert.ok(existsSync(resolved), `${name}/${file} extends ${target}, which does not exist`);
    }
  }

  // 2c. The tools its scripts run are its own devDependencies.
  const scripts = Object.values(manifest.scripts ?? {}).join("\n");
  const own = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const tool of ["tsc", "tsx", "vitest", "wrangler"]) {
    if (!new RegExp(`(?:^|[\\s&|;])${tool}(?:\\s|$)`, "u").test(scripts)) continue;
    const pkg = tool === "tsc" ? "typescript" : tool;
    assert.ok(own[pkg], `${name} runs ${tool} but does not declare ${pkg} in its own devDependencies`);
  }
}

function run(command, args, cwd) {
  say(`  $ ${args.length ? `${command} ${args.join(" ")}` : command}`);
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "1" } });
  assert.equal(result.status, 0, `${command} ${args[0]} failed in ${cwd}`);
}

const EXCLUDED = new Set([".artifacts", ".dev.vars", ".git", ".wrangler", "coverage", "dist", "node_modules"]);

function latestRelease(packageName) {
  const out = execFileSync(npm, ["view", packageName, "dist-tags.latest", "--json", "--registry", "https://registry.npmjs.org/"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function standaloneCheck(name, latestByName) {
  const source = join(cookbookRoot, name);
  const temporary = mkdtempSync(join(tmpdir(), `relay-cookbook-standalone-${name}-`));
  const copy = join(temporary, name);
  // The copy must live outside the workspace: node's resolver walks up parent
  // directories, so a copy under the repo could still find the workspace's
  // node_modules and prove nothing.
  assert.ok(relative(root, copy).startsWith(".."), `${copy} is inside the workspace`);
  try {
    cpSync(source, copy, {
      recursive: true,
      filter: (path) => !EXCLUDED.has(relative(source, path).split(/[\\/]/u)[0]),
    });
    const hasLock = existsSync(join(copy, "package-lock.json"));
    say(`  copied to ${copy}${hasLock ? " (with its own lockfile)" : ""}`);
    run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts"], copy);
    const manifest = readJson(join(copy, "package.json"));
    for (const dependency of relayDependencies(manifest)) {
      const installed = readJson(join(copy, "node_modules", ...dependency.name.split("/"), "package.json")).version;
      assert.doesNotMatch(
        installed,
        /-/u,
        `${name} installed ${dependency.name}@${installed}, a prerelease, from range ${dependency.range}`,
      );
      if (!hasLock) {
        const latest = latestByName.get(dependency.name) ?? latestRelease(dependency.name);
        latestByName.set(dependency.name, latest);
        assert.equal(
          installed,
          latest,
          `${name} installed ${dependency.name}@${installed}; npm latest is ${latest}`,
        );
      }
      say(`  ${name}: ${dependency.name}@${dependency.range} -> registry ${installed}`);
    }
    // --no-install: tsc must come from the folder's own devDependencies.
    run(npx, ["--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"], copy);
    say(`  ${name}: standalone ok`);
  } finally {
    if (process.env.RELAY_KEEP_STANDALONE === "1") say(`  kept ${copy}`);
    else rmSync(temporary, { recursive: true, force: true });
  }
}

say(`cookbook ${linkCheckOnly ? "link check" : "standalone check"}: ${checked.join(", ")}`);
if (linkCheckOnly) {
  for (const name of checked) linkCheck(name);
  say(`validated ${checked.length} cookbooks resolve the workspace Relay packages and stay inside their folders`);
} else {
  // npm 10.9's arborist crashes in #loadPeerSet on these folders (measured
  // 2026-09-07 on 10.9.8); CI installs npm@11.19.1 first, so name the npm
  // that ran before any install can fail for that reason.
  say(`  npm ${execFileSync(npm, ["--version"], { encoding: "utf8" }).trim()}`);
  const latestByName = new Map();
  for (const name of checked) {
    say(`\n=== ${name} ===`);
    standaloneCheck(name, latestByName);
  }
  say(`\nvalidated ${checked.length} cookbooks install from npm and type-check outside the workspace`);
}
