#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("private-sqlite-openat: native build not needed on this platform");
  process.exit(0);
}

const source = fileURLToPath(new URL(
  "../native/private-sqlite-openat.c",
  import.meta.url,
));
const output = fileURLToPath(new URL(
  "../dist/private-sqlite-openat",
  import.meta.url,
));
mkdirSync(fileURLToPath(new URL("../dist/", import.meta.url)), {
  recursive: true,
});

const compiler = process.env.CC?.trim() || "cc";
const result = spawnSync(compiler, [
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Wpedantic",
  "-Werror",
  "-O2",
  source,
  "-o",
  output,
], {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `private-sqlite-openat: ${compiler} exited with ${result.status}`,
  );
}
chmodSync(output, 0o755);
console.log(`private-sqlite-openat: built ${output}`);
