import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const source = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "relay-webhook-receiver-"));
const installed = join(temporary, "webhook-receiver");
const excluded = new Set([
  ".artifacts", ".dev.vars", ".git", ".wrangler", "coverage", "dist", "node_modules",
]);

function run(args) {
  execFileSync("npm", args, {
    cwd: installed,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
}

try {
  cpSync(source, installed, {
    filter: (path) => !excluded.has(relative(source, path).split(/[\\/]/u)[0]),
    recursive: true,
  });
  run(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  run(["run", "check"]);
  run(["run", "build"]);
  run(["test"]);
  console.log(`installed template ok (locked registry dependencies): ${basename(installed)}`);
} finally {
  if (process.env.RELAY_KEEP_INSTALLED_TEMPLATE !== "1") {
    rmSync(temporary, { force: true, recursive: true });
  } else {
    console.log(`kept installed template: ${installed}`);
  }
}
