// One ESM file per entry for every runtime. The sources import each other
// with .js extensions, so the declarations tsc writes resolve under
// moduleResolution nodenext as well as bundler. Every dependency
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
  // The entries share their modules through chunks, so a class such as
  // RelayPaymentRefused is one class whichever entry it is imported from.
  entryPoints: ["index", "actions", "memory"].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname),
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
