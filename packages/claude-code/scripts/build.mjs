import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "runtime/server.mjs");
const pluginOutfile = resolve(root, "plugin/runtime/server.mjs");
const packageJSON = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(root, "server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.22",
  packages: "bundle",
  sourcemap: false,
  legalComments: "eof",
  banner: {
    js: 'import { createRequire as __relayCreateRequire } from "node:module"; const require = __relayCreateRequire(import.meta.url);',
  },
  define: {
    __RELAY_CHANNEL_VERSION__: JSON.stringify(packageJSON.version),
  },
});
const bundled = await readFile(outfile, "utf8");
const normalized = bundled
  .replace(/^\/\/ (?:\.\.\/)+node_modules\//gmu, "// node_modules/")
  .replace(/"(?:(?:\.\.\/)+)node_modules\//gu, '"node_modules/')
  .replace(
    /^\/\/ (?:\.\.\/)+sdk\//gmu,
    "// node_modules/@relaymessenger/sdk/",
  )
  .replace(/^[\t ]+$/gmu, "");
await writeFile(outfile, normalized, "utf8");
await chmod(outfile, 0o755);
await mkdir(dirname(pluginOutfile), { recursive: true });
await copyFile(outfile, pluginOutfile);
await chmod(pluginOutfile, 0o755);
process.stdout.write(`built runtime/server.mjs for relay-claude-channel ${packageJSON.version}\n`);
