#!/usr/bin/env node
// Picks the CI legs a change needs. Pushes, manual runs, and pull requests
// into main run every leg. A pull request into any other branch runs the legs
// whose workspace it touches, plus every workspace that depends on one; a path
// outside a known workspace (root scripts, lockfile, workflows, contracts)
// runs every leg. An error also runs every leg: a broken selector must never
// turn a check into a skipped green one.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

// One leg per check that has caught a defect in CI on its own. `dirs` are the
// paths a leg owns; `build` are workspaces it needs built first.
export const legs = {
  workflows: { dirs: [], build: [], run: "workflows:check" },
  sdk: { dirs: ["packages/sdk", "test"], build: [], run: "validate:sdk" },
  "chat-sdk": { dirs: ["packages/chat-sdk-adapter"], build: ["@relaymessenger/sdk"], run: "validate:chat-sdk" },
  cli: { dirs: ["packages/cli", "packages/pi"], build: ["@relaymessenger/sdk", "@relaymessenger/pi"], run: "validate:cli" },
  openclaw: { dirs: ["packages/openclaw"], build: ["@relaymessenger/sdk"], run: "validate:openclaw" },
  "claude-code": { dirs: ["packages/claude-code"], build: ["@relaymessenger/sdk"], run: "validate:claude-code" },
  cookbook: { dirs: [], build: ["@relaymessenger/sdk", "@relaymessenger/chat-sdk-adapter"], run: "validate:cookbook" },
};

// Files no check reads.
const notes = new Set(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md", "scripts/agent-cli-platforms.md"]);
// Workspaces whose own suites run in the release (release-run.mjs), not in CI.
const releaseOnly = new Set(["packages/livekit", "packages/elevenlabs", "packages/think"]);

function workspaces() {
  const found = new Map();
  for (const parent of ["packages", "cookbook"]) {
    for (const name of readdirSync(parent)) {
      const path = `${parent}/${name}/package.json`;
      if (existsSync(path)) found.set(`${parent}/${name}`, JSON.parse(readFileSync(path, "utf8")));
    }
  }
  return found;
}

const legOf = dir => dir.startsWith("cookbook/") ? "cookbook" : Object.keys(legs).find(leg => legs[leg].dirs.includes(dir));

export function select({ event, baseRef, files }) {
  const all = { legs: Object.keys(legs), release: true };
  if (event !== "pull_request" || baseRef === "main") return all;
  const byDir = workspaces();
  const touched = new Set();
  let code = false;
  for (const file of files) {
    if (notes.has(file)) continue;
    code = true;
    const [parent, name] = file.split("/");
    const dir = file.startsWith("test/") ? "packages/sdk" : `${parent}/${name}`;
    if (parent === "python") continue; // release-python.yml tests python/** on pull requests
    if (parent === "cookbook" && !byDir.has(dir) && existsSync(dir)) continue; // Python cookbooks
    if (byDir.has(dir) && (legOf(dir) || releaseOnly.has(dir))) touched.add(dir);
    else return all;
  }
  for (let size = -1; size !== touched.size;) {
    size = touched.size;
    const names = new Set([...touched].map(dir => byDir.get(dir).name));
    for (const [dir, manifest] of byDir) {
      const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(field => Object.keys(manifest[field] ?? {}));
      if (deps.some(dep => names.has(dep))) touched.add(dir);
    }
  }
  const selected = new Set([...touched].map(legOf).filter(Boolean));
  if (code) selected.add("workflows");
  return { legs: Object.keys(legs).filter(leg => selected.has(leg)), release: false };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.EVENT;
  let plan;
  try {
    const files = event === "pull_request"
      ? execFileSync("git", ["diff", "--name-only", "-z", `${process.env.BASE}...${process.env.HEAD}`], { encoding: "utf8" }).split("\0").filter(Boolean)
      : [];
    plan = select({ event, baseRef: process.env.BASE_REF, files });
  } catch (error) {
    console.error(`Affected selection failed (${error.message}); running every leg.`);
    plan = select({ event: "push", files: [] });
  }
  const include = plan.legs.map(leg => ({ leg, run: legs[leg].run, build: legs[leg].build.map(name => `--workspace ${name}`).join(" ") }));
  const outputs = { matrix: JSON.stringify({ include }), any: String(include.length > 0), release: String(plan.release) };
  console.log(JSON.stringify(outputs, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
}
