// One ESM file for every runtime: the modules import each other without file
// extensions (they are copied unchanged from the agents, which bundle with
// Wrangler), so Node could not load tsc's per-file output. Every dependency
// stays external, so each agent keeps a single copy. Declarations come from
// `tsc -p tsconfig.build.json`.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
].flatMap((name) => [name, `${name}/*`]);

await build({
  // Two entries share their modules through chunks, so a class such as
  // RelayPaymentRefused is one class whichever entry it is imported from.
  entryPoints: ["index", "actions"].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname),
  outdir: new URL("../dist", import.meta.url).pathname,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: true,
  external,
  logLevel: "warning",
});
