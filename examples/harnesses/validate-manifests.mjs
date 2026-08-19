#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const requiredWorkspaces = [
  "packages/sdk",
  "examples/plugins/hermes",
];

let failed = 0;

for (const workspace of requiredWorkspaces) {
  const pkgPath = join(root, workspace, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg.name?.startsWith("@relaymessenger/")) {
      console.error(`manifest: ${workspace} name must be @relaymessenger/*`);
      failed += 1;
    }
    if (pkg.type !== "module") {
      console.error(`manifest: ${workspace} must be "type": "module"`);
      failed += 1;
    } else {
      console.log(`ok ${workspace} (${pkg.name})`);
    }
  } catch (error) {
    console.error(`manifest: missing ${pkgPath}: ${String(error)}`);
    failed += 1;
  }
}

for (const dir of ["packages", "examples", "examples/plugins"]) {
  const abs = join(root, dir);
  if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`missing directory ${dir}/`);
    failed += 1;
    continue;
  }
  const kids = readdirSync(abs);
  if (kids.length === 0) {
    console.error(`${dir}/ is empty`);
    failed += 1;
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log("manifests:check passed");
