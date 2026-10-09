// A builder's project, typechecked against the packed tarball: an empty
// directory, the package and its Relay dependencies installed from their
// tarballs, peers from the registry, and moduleResolution nodenext. A
// declaration whose relative import does not resolve turns its types into
// `any` without an error, so the check is that a wrong assignment FAILS.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDir = resolve(import.meta.dirname, "..");
const root = resolve(packageDir, "../..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const consumer = mkdtempSync(join(tmpdir(), "relay-think-types-"));

function npm(args, cwd) {
  execFileSync("npm", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

try {
  const packs = join(consumer, "packs");
  mkdirSync(packs);
  for (const workspace of ["@relaymessenger/think", "@relaymessenger/sdk", "@relaymessenger/chat-sdk-adapter"]) {
    npm(["pack", "--workspace", workspace, "--ignore-scripts", "--pack-destination", packs], root);
  }
  const tarballs = readdirSync(packs).map((name) => join(packs, name));
  assert.equal(tarballs.length, 3);
  const peers = Object.keys(manifest.peerDependencies).map((name) => `${name}@${manifest.devDependencies[name]}`);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  npm([
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    ...tarballs, ...peers, `typescript@${manifest.devDependencies.typescript}`,
  ], consumer);

  const check = (file, source) => {
    writeFileSync(join(consumer, file), source);
    const result = spawnSync(
      process.execPath,
      [
        join(consumer, "node_modules/typescript/bin/tsc"),
        "--target", "ES2022", "--module", "nodenext", "--moduleResolution", "nodenext",
        "--strict", "--noEmit", "--skipLibCheck", "--types", "", file,
      ],
      { cwd: consumer, encoding: "utf8" },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  const imports = `import { RelayGenerationActivities, createRelayClient } from "@relaymessenger/think";
import { relayActions, type RelayActionDependencies } from "@relaymessenger/think/actions";
import { personMemory, RelayPersonMemory, type PersonMemoryOptions } from "@relaymessenger/think/memory";
void createRelayClient; void relayActions; void personMemory; void RelayPersonMemory;
`;
  const good = check("good.ts", `${imports}export const probe: RelayActionDependencies["activities"] = new RelayGenerationActivities();\n`);
  assert.equal(good.status, 0, `the typed usage did not compile:\n${good.output}`);
  const bad = check("bad.ts", `${imports}export const probe: RelayActionDependencies["activities"] = 42;\n`);
  assert.notEqual(bad.status, 0, "a number was accepted as RelayGenerationActivities: the declarations resolve to any");
  assert.match(bad.output, /bad\.ts\(5,\d+\): error TS2322/u, bad.output);
  const badMemory = check("bad-memory.ts", `${imports}export const probe: PersonMemoryOptions["agentId"] = 42;\n`);
  assert.notEqual(badMemory.status, 0, "a number was accepted as an agentId: the memory declarations resolve to any");
  assert.match(badMemory.output, /bad-memory\.ts\(5,\d+\): error TS2322/u, badMemory.output);
  console.log("consumer_types_nodenext=ok");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
