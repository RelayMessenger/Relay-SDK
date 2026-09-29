import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Candidate {
  name: string;
  version: string;
  path: string;
  integrity: string;
}
interface CandidateTools {
  candidateTarball(input: {
    name: string;
    variable: string;
    env: Readonly<Record<string, string | undefined>>;
  }): Candidate | undefined;
  assertInstalledCandidate(
    consumer: string, importer: string, candidate: Candidate,
    options: { lockPath: string },
  ): void;
}

export const thinkCandidateMode = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  env.RELAY_SDK_CANDIDATE_TARBALL !== undefined
  || env.RELAY_CHAT_SDK_CANDIDATE_TARBALL !== undefined;

/** Verify the actual recipe resolution, never substitute workspace source. */
export async function verifyThinkCandidates(
  root = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  assert.ok(thinkCandidateMode(env), "Think candidate verification requires explicit archive env");
  assert.ok(env.RELAY_SDK_CANDIDATE_TARBALL && env.RELAY_CHAT_SDK_CANDIDATE_TARBALL,
    "Think candidate validation requires both SDK and Chat SDK tarballs");
  root = realpathSync(root);
  const helper = env.RELAY_THINK_CANDIDATE_HELPER
    ?? resolve(root, "../../packages/sdk/scripts/candidate-tarball.mjs");
  const lockPath = env.RELAY_THINK_CANDIDATE_LOCKFILE ?? join(root, "package-lock.json");
  assert.ok(isAbsolute(helper) && isAbsolute(lockPath), "Think candidate helper and install lock must be absolute");
  const tools = await import(/* @vite-ignore */ pathToFileURL(helper).href) as CandidateTools;
  const importer = join(root, "src/reply.ts");
  const require = createRequire(importer);
  const candidates = [
    tools.candidateTarball({ name: "@relaymessenger/sdk", variable: "RELAY_SDK_CANDIDATE_TARBALL", env }),
    tools.candidateTarball({ name: "@relaymessenger/chat-sdk-adapter", variable: "RELAY_CHAT_SDK_CANDIDATE_TARBALL", env }),
  ];
  for (const candidate of candidates) {
    assert.ok(candidate);
    const direct = join(root, "node_modules", candidate.name);
    assert.ok(!lstatSync(direct).isSymbolicLink(), "Think candidates must be installed directories, not workspace symlinks");
    assert.equal(realpathSync(direct), direct, "Think candidate node_modules must not traverse symlinks");
    assert.equal(dirname(require.resolve(`${candidate.name}/package.json`)), direct,
      "Think source must resolve its own nested candidate install");
    tools.assertInstalledCandidate(root, importer, candidate, { lockPath });
  }
  // An adapter must not quietly consume a nested registry SDK.
  const sdk = candidates[0]!;
  const adapterImporter = require.resolve("@relaymessenger/chat-sdk-adapter/package.json");
  tools.assertInstalledCandidate(root, adapterImporter, sdk, { lockPath });
  assert.equal(
    createRequire(adapterImporter).resolve("@relaymessenger/sdk/package.json"),
    require.resolve("@relaymessenger/sdk/package.json"),
    "Think and its adapter must resolve the same retained SDK",
  );
}
