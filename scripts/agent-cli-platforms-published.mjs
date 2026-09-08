// Explicit read-only registry audit. Source builds run in the preceding platform gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'linux' && !process.env.RELAY_DAYTONA_SANDBOX_ID) throw Error('Linux requires owned Daytona');
const receipts = resolve(process.env.RELAY_PLATFORM_RECEIPTS ?? join(root, '.release-tmp/agent-cli-platforms', `${process.platform}-${process.arch}`), 'published');
mkdirSync(receipts, { recursive: true });
const env = { ...process.env };
for (const key of ['RELAY_AGENT_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) delete env[key];
function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, `${command} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const npmBinary = run(process.platform === 'win32' ? 'where.exe' : 'which', ['npm']).split(/\r?\n/)[0];
const npmCli = process.env.npm_execpath ?? (process.platform === 'win32' ? join(dirname(npmBinary), 'node_modules/npm/bin/npm-cli.js') : realpathSync(npmBinary));
const npm = args => run(process.execPath, [npmCli, ...args]);
const sha = run('git', ['rev-parse', 'HEAD']);
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Registry comparison requires a clean source candidate');
const inventory = { candidateSha: sha, dirty: '', packages: [] };
const metadata = {};
// Owner froze these exact versions on 2026-09-08. Later tag movement is evidence,
// not permission to change the release under test.
const frozen = { cli: '0.1.0-staging.1', sdk: '0.3.1-staging.2' };
for (const [key, dir, name] of [['cli', 'cli', 'relaymessenger'], ['sdk', 'sdk', '@relaymessenger/sdk']]) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json')));
  assert.equal(manifest.version, frozen[key], 'Do not change the frozen release under test');
  metadata[key] = JSON.parse(npm(['view', `${name}@${frozen[key]}`, '--json']));
  const [pack] = JSON.parse(npm(['pack', '--workspace', name, '--dry-run', '--ignore-scripts', '--json']));
  const files = Object.fromEntries(pack.files.map(({ path }) => [
    `package/${path}`, createHash('sha256').update(readFileSync(join(root, 'packages', dir, path))).digest('hex'),
  ]));
  inventory.packages.push({ name, manifest, files });
}
// npm omits gitHead for retained-tarball publication. The release bump is the
// nearest ancestor that changed this manifest; actual byte parity remains mandatory.
const sourceSha = run('git', ['log', '-1', '--format=%H', '--', 'packages/cli/package.json']);
writeFileSync(join(receipts, 'source-candidate.json'), JSON.stringify(inventory, null, 2));
// The frozen registry release cannot contain an unpublished regression fix.
// Keep its previously verified inventory immutable, rather than relaxing the
// published-byte comparison to accept the fixed candidate's different code.
const inventoryPath = join(root, 'scripts/agent-cli-platforms-frozen-c4703ec.json');
const frozenInventory = JSON.parse(readFileSync(inventoryPath));
assert.equal(frozenInventory.publisherSourceSha, sourceSha);
const changes = [];
for (const pkg of inventory.packages) {
  const previous = frozenInventory.packages.find(item => item.name === pkg.name);
  assert.ok(previous); assert.deepEqual(pkg.manifest, previous.manifest);
  assert.deepEqual(Object.keys(pkg.files).sort(), Object.keys(previous.files).sort());
  const changed = Object.keys(pkg.files).filter(file => pkg.files[file] !== previous.files[file]);
  for (const file of changed) {
    assert.equal(pkg.name, 'relaymessenger', 'Only the CLI lock regression changed runtime code');
    assert.ok(['package/dist/config.js', 'package/dist/config.js.map', 'package/dist/config.d.ts.map'].includes(file), `Unreviewed source/registry difference: ${file}`);
  }
  changes.push({ name: pkg.name, changedFiles: changed });
}
writeFileSync(join(receipts, 'unpublished-source-delta.json'), JSON.stringify({
  sourceCandidateSha: sha, frozenPublisherSha: sourceSha, changes,
  limitation: 'Frozen CLI still contains the observed Windows config-lock EPERM race; its fix is unpublished.',
}, null, 2));
const plan = {
  phase: 'cli-sdk-only', registry: 'https://registry.npmjs.org/',
  publishSha: sourceSha, inventoryPath,
  comparisonScope: 'Frozen publisher source, not the unpublished fixed candidate',
  frozenByOwner: true, frozenAt: '2026-09-08',
  cliVersion: metadata.cli.version, sdkVersion: metadata.sdk.version,
};
const planPath = join(receipts, 'plan.json');
writeFileSync(planPath, JSON.stringify(plan, null, 2));
const r = spawnSync(process.execPath, [join(root, 'scripts/agent-cli-platforms.mjs')], {
  cwd: root, env: { ...env, RELAY_PLATFORM_PUBLISHED_PLAN: planPath, RELAY_PLATFORM_RECEIPTS: receipts, RELAY_TMUX_PROOF: '0' },
  stdio: 'inherit', timeout: 1800000,
});
process.exitCode = r.status ?? 1;
