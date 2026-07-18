import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "runtime/server.mjs");

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(root, "server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.11",
  packages: "bundle",
  sourcemap: false,
  legalComments: "eof",
});

// Some bundled dependencies contain whitespace-only lines inside generated
// template literals. Keep the checked-in artifact diff-clean without changing
// any non-whitespace string content.
const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/^[\t ]+$/gm, ""), "utf8");
