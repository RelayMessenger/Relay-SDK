import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "runtime/server.mjs");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

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
  // One source of truth for the version: the manifest. The runtime cannot read
  // package.json relatively, because dev runs from the package root and the
  // bundle runs from runtime/.
  define: { __RELAY_CHANNEL_VERSION__: JSON.stringify(version) },
});

// Some bundled dependencies contain whitespace-only lines inside generated
// template literals. Keep the checked-in artifact diff-clean without changing
// any non-whitespace string content.
const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/^[\t ]+$/gm, ""), "utf8");
