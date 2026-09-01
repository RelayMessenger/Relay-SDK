import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const status = execFileSync(
  "git",
  ["status", "--porcelain=v2", "--untracked-files=no"],
  { encoding: "utf8" },
);
assert.equal(status, "", `tracked source changed during validation:\n${status}`);
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
console.log(`tracked_tree_clean=${head}`);
