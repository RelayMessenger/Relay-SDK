import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { candidateTarball, candidateConsumerManifest, assertInstalledCandidate } from "../scripts/candidate-tarball.mjs";

const scratch = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-candidate-proof-"));
  scratch.push(root);
  mkdirSync(join(root, "package/dist"), { recursive: true });
  writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "@relaymessenger/sdk", version: "1.0.0-test.1", main: "./dist/index.js" }));
  writeFileSync(join(root, "package/dist/index.js"), "export const candidate = true;\n");
  const path = join(root, "sdk.tgz");
  execFileSync("tar", ["-czf", path, "-C", root, "package"]);
  const input = { name: "@relaymessenger/sdk", version: "1.0.0-test.1", variable: "CANDIDATE", env: { CANDIDATE: path } };
  return { root, input, candidate: candidateTarball(input) };
}

it("leaves registry mode untouched and rejects wrong candidate identity/version", () => {
  expect(candidateTarball({ name: "@relaymessenger/sdk", variable: "CANDIDATE", env: {} })).toBeUndefined();
  const { input } = fixture();
  expect(() => candidateTarball({ ...input, name: "wrong-package" })).toThrow("identity");
  expect(() => candidateTarball({ ...input, version: "2.0.0" })).toThrow("declared dependency version");
  expect(() => candidateTarball({ ...input, env: { CANDIDATE: "relative.tgz" } })).toThrow("absolute");
});

it("changes only the disposable consumer and overrides nested registry copies explicitly", () => {
  const { candidate } = fixture();
  const manifest = { private: true, dependencies: { other: "1.0.0" } };
  const consumer = candidateConsumerManifest(manifest, [candidate]);
  expect(manifest).toEqual({ private: true, dependencies: { other: "1.0.0" } });
  expect(consumer.dependencies["@relaymessenger/sdk"]).toBe(`file:${candidate.path}`);
  expect(consumer.overrides["@relaymessenger/sdk"]).toBe("$@relaymessenger/sdk");
  expect(candidate.integrity).toMatch(/^sha512-/u);
});

it("rejects registry integrity or installed bytes that differ from the retained candidate", () => {
  const { root, candidate } = fixture();
  const consumer = join(root, "consumer");
  const key = "node_modules/@relaymessenger/sdk";
  cpSync(join(root, "package"), join(consumer, key), { recursive: true });
  const importer = join(consumer, "package.json");
  writeFileSync(importer, "{}");
  const lock = integrity => writeFileSync(join(consumer, "package-lock.json"), JSON.stringify({ packages: { [key]: { integrity } } }));
  lock("registry-bytes");
  expect(() => assertInstalledCandidate(consumer, importer, candidate)).toThrow("integrity");
  lock(candidate.integrity);
  expect(() => assertInstalledCandidate(consumer, importer, candidate)).not.toThrow();
  writeFileSync(join(consumer, key, "dist/index.js"), "export const candidate = false;\n");
  expect(() => assertInstalledCandidate(consumer, importer, candidate)).toThrow("installed entry differs");
});
