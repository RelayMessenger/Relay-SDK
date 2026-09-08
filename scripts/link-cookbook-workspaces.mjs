// Root-install-only wiring. Cookbook manifests keep their registry ranges so
// a standalone copy installs stable releases; those same ranges intentionally
// need not accept every future workspace prerelease tuple.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releasePackages } from "./release-packages.mjs";

export function linkCookbookWorkspaces(root) {
  const targets = new Map(Object.values(releasePackages).map((entry) => [entry.workspace, join(root, entry.directory)]));
  const linked = [];
  for (const name of readdirSync(join(root, "cookbook"))) {
    const directory = join(root, "cookbook", name);
    const path = join(directory, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    // Same exception as validate-cookbook-standalone: locked templates prove
    // the actual published dependencies with their own installed-copy tests.
    if (existsSync(join(directory, "package-lock.json")) && manifest.scripts?.["test:installed"]) continue;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        const target = targets.get(dependency);
        if (!target) continue;
        const actual = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
        assert.equal(actual.name, dependency);
        const destination = join(directory, "node_modules", dependency);
        if (existsSync(destination) && realpathSync(destination) === realpathSync(target)) continue;
        // Only disposable installed Relay dependencies, never source files.
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
        linked.push(`${name}: ${dependency}`);
      }
    }
  }
  return linked;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const linked = linkCookbookWorkspaces(resolve(import.meta.dirname, ".."));
  console.log(`linked ${linked.length} cookbook Relay dependencies to canonical workspaces`);
}
