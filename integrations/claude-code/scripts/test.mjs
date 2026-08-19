import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(root, "test", name));

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
